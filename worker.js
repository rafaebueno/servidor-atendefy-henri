require('dotenv').config();

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const supabase = require('./supabase.js');

const INSTANCE_ID = process.env.INSTANCE_ID || 1;
const RECONCILE_INTERVAL_MS = 60000;
const POLLING_INTERVAL_BASE_MS = 20000;
const RECONNECT_DELAY_MS = 30000;

const managedMailboxes = new Map();

function log(level, message, details = {}) {
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    instanceId: INSTANCE_ID,
    ...details,
    message,
  }));
}

class MailboxManager {
  constructor(credentials) {
    this.credentials = credentials;
    this.client = null;
    this.syncStatus = null;
    this.isConnecting = false;
    this.isPolling = false;
    this.lastChecked = 0;
    this.pollingInterval = POLLING_INTERVAL_BASE_MS + Math.floor(Math.random() * 5000);
    this.logDetails = { mailboxId: this.credentials.id, email: this.credentials.email };
    this.connectionStartTime = null;
    this.lastImapActivity = null;
  }

  async initialize() {
    const { data: status, error } = await supabase
      .from('mailbox_sync_status')
      .select('*')
      .eq('mailbox_id', this.credentials.id)
      .single();

    if (error && error.code !== 'PGRST116') {
      log('ERROR', 'Erro ao buscar estado de sincronização.', { ...this.logDetails, error });
      return false;
    }

    if (status) {
      this.syncStatus = status;
    } else {
      const { data: newStatus, error: insertError } = await supabase
        .from('mailbox_sync_status')
        .insert({
          email: this.credentials.email,
          mailbox_id: this.credentials.id,
          last_processed_uid: 0
        })
        .select()
        .single();

      if (insertError) {
        log('ERROR', 'Erro ao criar estado inicial.', { ...this.logDetails, error: insertError });
        return false;
      }

      this.syncStatus = newStatus;
    }
    return true;
  }

  async connect() {
    if (this.isConnecting) {
      log('WARN', 'Conexao ja em andamento, aguardando...', this.logDetails);
      return;
    }
    if (this.client !== null) {
      log('WARN', 'Cliente ja existe, bloqueando nova conexao.', this.logDetails);
      return;
    }

    this.isConnecting = true;

    const imapConfig = {
      host: this.credentials.imap_host,
      port: this.credentials.imap_port || 993,
      secure: this.credentials.imap_secure,
      idling: true,
      keepalive: {
        idleInterval: 15000,
        interval: 10000,
        maxCount: 3
      }
    };

    log('INFO', 'Conectando via ImapFlow...', {
      ...this.logDetails,
      provider: this.credentials.imap_host,
      config: imapConfig
    });

    try {
      this.client = new ImapFlow({
        ...imapConfig,
        auth: {
          user: this.credentials.email,
          pass: this.credentials.password
        },
        logger: false
      });

      this.client.on('error', (err) => {
        log('ERROR', 'Erro IMAP capturado antes do close.', {
          ...this.logDetails,
          error: err.message,
          stack: err.stack,
          code: err.code,
          provider: this.credentials.imap_host,
          uptime: this.connectionStartTime ? Math.floor((Date.now() - this.connectionStartTime) / 1000) + 's' : null,
          lastActivity: this.lastImapActivity
        });
      });

      this.client.on('close', () => {
        const uptime = this.connectionStartTime ? Math.floor((Date.now() - this.connectionStartTime) / 1000) : 0;
        log('WARN', 'Conexão IMAP fechada inesperadamente.', {
          ...this.logDetails,
          provider: this.credentials.imap_host,
          uptimeSeconds: uptime,
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
          lastActivity: this.lastImapActivity,
          wasPolling: this.isPolling
        });
        this.client = null;
        this.connectionStartTime = null;
      });

      await this.client.connect();
      await this.client.mailboxOpen('INBOX');

      this.connectionStartTime = Date.now();
      this.lastImapActivity = new Date().toISOString();
      this.isConnecting = false;

      log('INFO', 'Conexão IMAP estabelecida.', {
        ...this.logDetails,
        provider: this.credentials.imap_host,
        connectedAt: this.lastImapActivity
      });

      if (!this.syncStatus.initial_sync_completed_at) {
        const firstSyncTime = new Date().toISOString();
        const latestUID = this.client.mailbox.exists ? this.client.mailbox.uidNext - 1 : 0;

        await this.updateSyncStatus({
          initial_sync_completed_at: firstSyncTime,
          last_processed_uid: latestUID
        });

        log('INFO', `Primeira sincronização concluída. Último UID: ${latestUID}.`, this.logDetails);
      }

    } catch (error) {
      log('ERROR', 'Erro ao conectar.', {
        ...this.logDetails,
        error: error.message
      });
      this.isConnecting = false;

      if (this.client) await this.client.logout().catch(() => {});
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
  }

  async disconnect() {
    if (this.client) {
      log('INFO', 'Desconectando...', this.logDetails);
      await this.client.logout().catch(() => {});
      this.client = null;
    }
  }

  async pollForNewEmails() {
    if (this.isPolling) return;
    if (this.client === null) {
      log('INFO', 'Cliente desconectado, reconectando...', this.logDetails);
      return this.connect();
    }

    if (!this.syncStatus.initial_sync_completed_at) return;

    this.isPolling = true;
    this.lastChecked = Date.now();
    this.lastImapActivity = new Date().toISOString();
    await this.updateSyncStatus({ last_synced_at: new Date().toISOString() });

    const lastUID = this.syncStatus.last_processed_uid;
    const nextUID = lastUID + 1;

    log('INFO', `Verificando novos e-mails desde UID ${nextUID}.`, this.logDetails);

    try {
      const lock = await this.client.getMailboxLock('INBOX');
      this.lastImapActivity = new Date().toISOString();
      let processedCount = 0;

      try {
        for await (const msg of this.client.fetch({ uid: `${nextUID}:*` }, { uid: true, source: true })) {
          if (msg.uid <= lastUID) continue;

          const parsed = await simpleParser(msg.source);
          const saved = await this.saveEmailToDb(parsed, msg.uid);

          if (saved) {
            await this.updateSyncStatus({ last_processed_uid: msg.uid });
            await this.sendToWebhook(parsed);
            processedCount++;
          }
        }

        if (processedCount) {
          log('INFO', `${processedCount} novo(s) e-mail(s).`, this.logDetails);
        } else {
          log('INFO', 'Nenhum novo e-mail.', this.logDetails);
        }

      } finally {
        lock.release();
      }
    } catch (err) {
      log('ERROR', 'Erro ao buscar e-mails.', { ...this.logDetails, error: err.message });
      await this.disconnect();

    } finally {
      this.isPolling = false;
    }
  }

  async saveEmailToDb(parsedEmail, uid) {
    let originalFrom = null;
    const returnPath = parsedEmail.headers.get('return-path');
    if (returnPath?.value?.[0]?.address) {
      originalFrom = returnPath.value[0].address;
    }

    const emailData = {
      mailbox_id: this.credentials.id,
      email: this.credentials.email,
      message_id: parsedEmail.messageId,
      uid,
      sender: {
        address: parsedEmail.from?.value[0]?.address,
        name: parsedEmail.from?.value[0]?.name
      },
      recipients: parsedEmail.to?.value,
      subject: parsedEmail.subject,
      body_text: parsedEmail.text,
      body_html: parsedEmail.html || null,
      received_at: parsedEmail.date,
      has_attachments: parsedEmail.attachments?.length > 0,
      original_from: originalFrom,
      raw_headers: parsedEmail.headers
    };

    const { error } = await supabase.from('emails').insert(emailData);

    if (error) {
      if (error.code === '23505') {
        log('WARN', `E-mail duplicado (id: ${parsedEmail.messageId}).`, this.logDetails);
        return null;
      }
      throw error;
    }

    return emailData;
  }

  async sendToWebhook(parsedEmail) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) return;

    let originalFrom = null;
    const returnPath = parsedEmail.headers.get('return-path');
    if (returnPath?.value?.[0]?.address) {
      originalFrom = returnPath.value[0].address;
    }

    try {
      await axios.post(webhookUrl, {
        client_id: this.credentials.email,
        from: parsedEmail.from?.value[0]?.address,
        to: parsedEmail.to?.value[0]?.address,
        subject: parsedEmail.subject,
        message_id: parsedEmail.messageId,
        date: parsedEmail.date,
        original_from: originalFrom,
        text: parsedEmail.text,
        html: parsedEmail.html
      });

      log('INFO', `Webhook enviado (${parsedEmail.messageId}).`, this.logDetails);

    } catch (error) {
      log('ERROR', 'Falha ao enviar webhook.', { ...this.logDetails, error: error.message });
    }
  }

  async updateSyncStatus(fieldsToUpdate) {
    const { error } = await supabase
      .from('mailbox_sync_status')
      .update({ ...fieldsToUpdate, last_synced_at: new Date().toISOString() })
      .eq('mailbox_id', this.credentials.id);

    if (error) {
      log('ERROR', 'Falha ao atualizar sync_status.', { ...this.logDetails, error });
    } else {
      this.syncStatus = { ...this.syncStatus, ...fieldsToUpdate };
    }
  }
}

async function reconcileAndManageMailboxes() {
  log('INFO', 'Reconciliação de mailboxes...');

  try {
    const { data: assignedMailboxes, error } = await supabase
      .from('mailboxes')
      .select('*')
      .eq('active', true)
      .eq('instance_id', INSTANCE_ID);

    if (error) {
      log('ERROR', 'Falha ao buscar mailboxes', { error });
      return;
    }

    const dbMailboxIds = new Set(assignedMailboxes.map(mb => mb.id));

    for (const mailboxCredentials of assignedMailboxes) {
      if (!managedMailboxes.has(mailboxCredentials.id)) {
        log('INFO', `Nova mailbox: ${mailboxCredentials.email}.`, { mailboxId: mailboxCredentials.id });

        const manager = new MailboxManager(mailboxCredentials);
        managedMailboxes.set(mailboxCredentials.id, manager);

        const ok = await manager.initialize();
        if (ok) await manager.connect();
      }
    }

    for (const mailboxId of managedMailboxes.keys()) {
      if (!dbMailboxIds.has(mailboxId)) {
        log('INFO', 'Removendo mailbox desativada.', { mailboxId });

        const manager = managedMailboxes.get(mailboxId);
        await manager.disconnect();
        managedMailboxes.delete(mailboxId);
      }
    }

  } catch (e) {
    log('ERROR', 'Erro na reconciliação.', { error: e.message });
  }
}

function pollManagedMailboxes() {
  managedMailboxes.forEach(manager => {
    if (Date.now() - manager.lastChecked > manager.pollingInterval) {
      manager.pollForNewEmails();
    }
  });
}

async function main() {
  log('INFO', 'Iniciando Multi-Worker (ImapFlow)...');

  await reconcileAndManageMailboxes();

  setInterval(reconcileAndManageMailboxes, RECONCILE_INTERVAL_MS);
  setInterval(pollManagedMailboxes, 5000);

  process.on('SIGINT', async () => {
    log('INFO', 'Encerrando conexões...');

    for (const manager of managedMailboxes.values()) {
      await manager.disconnect();
    }

    setTimeout(() => process.exit(0), 2000);
  });
}

main();

module.exports = { managedMailboxes };
