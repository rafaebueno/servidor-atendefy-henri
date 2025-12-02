require('dotenv').config();

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const axios = require('axios');
const supabase = require('./supabase.js');

const INSTANCE_ID = process.env.INSTANCE_ID || 1;
const RECONCILE_INTERVAL_MS = 60000;
const POLLING_INTERVAL_BASE_MS = 20000;
const RECONNECT_DELAY_MS = 30000;
const LOCK_TIMEOUT_MS = 30000;

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
    // Cache de message_id enviados recentemente (previne duplicação de webhook)
    this.sentWebhooks = new Set();
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
        idleInterval: 90000,
        interval: 30000,
        maxCount: 5
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

        // Limpa client em caso de erro para evitar estado inconsistente
        if (this.client) {
          this.client.logout().catch(() => { });
          this.client = null;
          this.connectionStartTime = null;
        }
      });

      this.client.on('close', () => {
        const uptime = this.connectionStartTime ? Math.floor((Date.now() - this.connectionStartTime) / 1000) : 0;
        const timeSinceLastActivity = this.lastImapActivity
          ? Math.floor((Date.now() - new Date(this.lastImapActivity).getTime()) / 1000)
          : null;

        log('WARN', 'Conexão IMAP fechada inesperadamente.', {
          ...this.logDetails,
          provider: this.credentials.imap_host,
          port: this.credentials.imap_port || 993,
          uptimeSeconds: uptime,
          uptimeFormatted: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`,
          lastActivity: this.lastImapActivity,
          timeSinceLastActivitySeconds: timeSinceLastActivity,
          timeSinceLastActivityFormatted: timeSinceLastActivity
            ? `${Math.floor(timeSinceLastActivity / 60)}m ${timeSinceLastActivity % 60}s`
            : null,
          wasPolling: this.isPolling,
          wasConnecting: this.isConnecting,
          keepaliveConfig: {
            idleInterval: 90000,
            interval: 30000,
            maxCount: 5
          },
          lastProcessedUid: this.syncStatus?.last_processed_uid || 0,
          initialSyncCompleted: !!this.syncStatus?.initial_sync_completed_at
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

      if (this.client) await this.client.logout().catch(() => { });
      setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
    }
  }

  async disconnect() {
    if (this.client) {
      log('INFO', 'Desconectando...', this.logDetails);
      await this.client.logout().catch(() => { });
      this.client = null;
    }
  }

  async pollForNewEmails() {
    // CRITICAL: Seta flag IMEDIATAMENTE para prevenir race condition
    if (this.isPolling) {
      log('DEBUG', 'Polling já em andamento, ignorando chamada duplicada.', this.logDetails);
      return;
    }
    this.isPolling = true;

    // Validações após setar a flag
    if (this.client === null) {
      log('INFO', 'Cliente desconectado, reconectando...', this.logDetails);
      this.isPolling = false;  // Reseta flag antes de retornar
      return this.connect();
    }

    if (!this.syncStatus.initial_sync_completed_at) {
      this.isPolling = false;  // Reseta flag antes de retornar
      return;
    }
    this.lastChecked = Date.now();
    this.lastImapActivity = new Date().toISOString();
    await this.updateSyncStatus({ last_synced_at: new Date().toISOString() });

    const lastUID = this.syncStatus.last_processed_uid;
    const nextUID = lastUID + 1;

    log('INFO', `Verificando novos e-mails desde UID ${nextUID}.`, this.logDetails);

    try {
      const lockPromise = this.client.getMailboxLock('INBOX');
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Lock timeout')), LOCK_TIMEOUT_MS)
      );

      const lock = await Promise.race([lockPromise, timeoutPromise]);
      this.lastImapActivity = new Date().toISOString();
      let processedCount = 0;

      try {
        for await (const msg of this.client.fetch({ uid: `${nextUID}:*` }, { uid: true, source: true })) {
          if (msg.uid <= lastUID) continue;

          const parsed = await simpleParser(msg.source);
          const saved = await this.saveEmailToDb(parsed, msg.uid);

          if (saved) {
            // SEMPRE atualiza UID (mesmo se email já foi processado)
            // Isso garante que a fila avança e não fica presa
            await this.updateSyncStatus({ last_processed_uid: msg.uid });

            // Só envia webhook se for email NOVO (não já processado)
            if (!saved.alreadyProcessed) {
              await this.sendToWebhook(parsed);
              processedCount++;
            }
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

    // Usar UPSERT em vez de INSERT para tornar operação idempotente
    const { data, error } = await supabase
      .from('emails')
      .upsert(emailData, {
        onConflict: 'mailbox_id,uid',  // Usa constraint UNIQUE existente
        ignoreDuplicates: true          // Ignora se já existe (não atualiza)
      })
      .select();

    if (error) {
      // Apenas erros reais (não duplicação)
      throw error;
    }

    // Detectar se foi inserido (novo) ou ignorado (já existia)
    const wasInserted = data && data.length > 0;

    if (!wasInserted) {
      // Email já foi processado anteriormente, apenas logar em DEBUG
      log('DEBUG', `E-mail já processado (UID: ${uid}), pulando.`, this.logDetails);
      return { alreadyProcessed: true, uid, emailData };
    }

    // Email novo, processado com sucesso
    return { alreadyProcessed: false, uid, emailData };
  }

  async sendToWebhook(parsedEmail, attempt = 1, maxRetries = 3) {
    const webhookUrl = process.env.WEBHOOK_URL;
    if (!webhookUrl) {
      log('WARN', 'WEBHOOK_URL não configurada, pulando envio.', this.logDetails);
      return;
    }

    // DEDUPLICAÇÃO: Verifica se webhook já foi enviado para este message_id
    const messageId = parsedEmail.messageId;
    if (attempt === 1 && this.sentWebhooks.has(messageId)) {
      log('WARN', 'Webhook já enviado para este message_id, ignorando duplicata.', {
        ...this.logDetails,
        messageId: messageId,
        cacheSize: this.sentWebhooks.size
      });
      return;
    }

    let originalFrom = null;
    const returnPath = parsedEmail.headers.get('return-path');
    if (returnPath?.value?.[0]?.address) {
      originalFrom = returnPath.value[0].address;
    }

    const payload = {
      client_id: this.credentials.email,
      from: parsedEmail.from?.value[0]?.address,
      to: parsedEmail.to?.value[0]?.address,
      subject: parsedEmail.subject,
      message_id: messageId,
      date: parsedEmail.date,
      original_from: originalFrom,
      text: parsedEmail.text,
      html: parsedEmail.html
    };

    // Validação de payload
    const payloadValidation = {
      hasClientId: !!payload.client_id,
      hasFrom: !!payload.from,
      hasTo: !!payload.to,
      hasSubject: !!payload.subject,
      hasMessageId: !!payload.message_id,
      hasText: !!payload.text,
      hasHtml: !!payload.html,
      textLength: payload.text ? payload.text.length : 0,
      htmlLength: payload.html ? payload.html.length : 0,
      textHasNonPrintable: payload.text ? /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(payload.text) : false,
      htmlHasNonPrintable: payload.html ? /[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(payload.html) : false
    };

    const startTime = Date.now();
    const payloadString = JSON.stringify(payload);
    const payloadSize = payloadString.length;

    log('INFO', 'Iniciando envio de webhook...', {
      ...this.logDetails,
      messageId: parsedEmail.messageId,
      webhookUrl: webhookUrl,
      payloadSize: payloadSize,
      attempt: attempt,
      maxRetries: maxRetries,
      validation: payloadValidation
    });

    // Log detalhado se payload for suspeito (muito grande ou com caracteres inválidos)
    if (payloadSize > 100000 || payloadValidation.textHasNonPrintable || payloadValidation.htmlHasNonPrintable) {
      log('WARN', 'Payload suspeito detectado!', {
        ...this.logDetails,
        messageId: parsedEmail.messageId,
        payloadSize: payloadSize,
        textLength: payloadValidation.textLength,
        htmlLength: payloadValidation.htmlLength,
        hasNonPrintableChars: payloadValidation.textHasNonPrintable || payloadValidation.htmlHasNonPrintable,
        // Mostrar primeiro trecho do payload para debug
        payloadPreview: payloadString.substring(0, 500)
      });
    }

    try {
      const response = await axios.post(webhookUrl, payload, {
        timeout: 30000, // 30 segundos
        headers: {
          'Content-Type': 'application/json'
        },
        validateStatus: function (status) {
          return status >= 200 && status < 300; // Aceita apenas 2xx como sucesso
        }
      });

      const duration = Date.now() - startTime;

      log('INFO', 'Webhook enviado com sucesso!', {
        ...this.logDetails,
        messageId: parsedEmail.messageId,
        webhookUrl: webhookUrl,
        statusCode: response.status,
        statusText: response.statusText,
        durationMs: duration,
        responseData: response.data ? JSON.stringify(response.data).substring(0, 200) : null,
        attempt: attempt,
        retriesUsed: attempt - 1
      });

      // Adiciona ao cache de webhooks enviados (previne duplicação futura)
      this.sentWebhooks.add(messageId);

      // Limpa cache se ficar muito grande (mantém últimos 1000)
      if (this.sentWebhooks.size > 1000) {
        const toDelete = Array.from(this.sentWebhooks).slice(0, 500);
        toDelete.forEach(id => this.sentWebhooks.delete(id));
      }

      return true; // Sucesso

    } catch (error) {
      const duration = Date.now() - startTime;

      // Detalhamento específico do erro
      const errorDetails = {
        ...this.logDetails,
        messageId: parsedEmail.messageId,
        webhookUrl: webhookUrl,
        durationMs: duration,
        errorMessage: error.message,
        errorCode: error.code,
        payloadSize: JSON.stringify(payload).length,
        attempt: attempt,
        maxRetries: maxRetries
      };

      // Capturar detalhes da resposta HTTP se existir
      if (error.response) {
        errorDetails.httpStatus = error.response.status;
        errorDetails.httpStatusText = error.response.statusText;
        errorDetails.responseData = error.response.data ? JSON.stringify(error.response.data).substring(0, 200) : null;
        errorDetails.responseHeaders = error.response.headers;
      }

      // Capturar detalhes da requisição se não houve resposta
      if (error.request && !error.response) {
        errorDetails.requestSent = true;
        errorDetails.noResponse = true;
        errorDetails.possibleCause = 'Timeout, rede offline ou servidor N8N não respondeu';
      }

      // Timeout específico
      if (error.code === 'ECONNABORTED') {
        errorDetails.timeoutExceeded = true;
        errorDetails.timeoutMs = 30000;
      }

      // Decidir se deve retentar
      const shouldRetry = attempt < maxRetries && (
        error.code === 'ECONNABORTED' || // Timeout
        error.code === 'ECONNREFUSED' || // Conexão recusada
        error.code === 'ENOTFOUND' ||    // DNS não encontrado
        error.code === 'ETIMEDOUT' ||    // Timeout de rede
        (error.response && error.response.status >= 500) // Erro 5xx do servidor
      );

      if (shouldRetry) {
        const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 1), 10000); // Exponential backoff (max 10s)
        errorDetails.willRetry = true;
        errorDetails.retryAfterMs = backoffDelay;

        log('WARN', 'Falha ao enviar webhook, tentando novamente...', errorDetails);

        // Aguardar antes de retentar
        await new Promise(resolve => setTimeout(resolve, backoffDelay));

        // Retentar recursivamente
        return this.sendToWebhook(parsedEmail, attempt + 1, maxRetries);
      } else {
        errorDetails.willRetry = false;
        errorDetails.reason = attempt >= maxRetries
          ? 'Máximo de tentativas atingido'
          : 'Erro não recuperável';

        log('ERROR', 'FALHA DEFINITIVA ao enviar webhook!', errorDetails);
        return false; // Falha definitiva
      }
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
