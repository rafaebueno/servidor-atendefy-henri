require('dotenv').config();
const express = require('express');
const nodemailer = require('nodemailer');
const supabase = require('./supabase.js');
const Imap = require('node-imap');
const { managedMailboxes } = require('./worker.js');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const INSTANCE_ID = process.env.INSTANCE_ID || 1;

function validateImapCredentials(config) {
  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user: config.email,
      password: config.password,
      host: config.imap_host,
      port: config.imap_port,
      tls: config.imap_secure,
    });

    const onError = (err) => {
      imap.removeListener('ready', onReady);
      reject(new Error(`Falha na validação IMAP: ${err.message}`));
    };

    const onReady = () => {
      imap.removeListener('error', onError);
      imap.end();
      resolve(true);
    };

    imap.once('ready', onReady);
    imap.once('error', onError);
    imap.connect();
  });
}

function validateSmtpCredentials(config) {
  return new Promise((resolve, reject) => {
    const transporter = nodemailer.createTransport({
      host: config.smtp_host,
      port: config.smtp_port,
      secure: config.smtp_secure,
      auth: {
        user: config.email,
        pass: config.password,
      },
    });

    transporter.verify((error, success) => {
      if (error) {
        reject(new Error(`Falha na validação SMTP: ${error.message}`));
      } else {
        resolve(true);
      }
    });
  });
}

app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

app.get('/health/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const { data: mailData } = await supabase.from('mailboxes').select('id').eq('email', email).single();
    if (!mailData) {
      return res.status(404).json({ status: 'not_found', message: 'Mailbox not found.' });
    }
    const { data, error } = await supabase.from('mailbox_sync_status').select('last_synced_at').eq('mailbox_id', mailData.id).single();
    if (error) throw error;

    const lastSyncedAt = data.last_synced_at || null;
    const now = Date.now();
    const syncedTime = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
    const fiveMinutes = 5 * 60 * 1000;

    if (lastSyncedAt && (now - syncedTime <= fiveMinutes)) {
      res.status(200).json({ status: 'ready', last_synced_at: lastSyncedAt });
    } else {
      res.status(200).json({ status: 'not_ready', last_synced_at: lastSyncedAt });
    }
  } catch (error) {
    res.status(503).json({ status: 'not_ready', dependencies: { database: 'error', details: error.message } });
  }
});

app.get('/api/mailboxes', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('mailboxes')
      .select('id, email, active, imap_host, smtp_host, created_at');

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Erro ao buscar mailboxes', details: error.message });
  }
});

app.post('/api/mailboxes', async (req, res) => {
  try {
    const { email, password, imap_host, imap_port, smtp_host, smtp_port, smtp_secure, imap_secure } = req.body;

    if (!email || !password || !imap_host || !imap_port || (imap_secure !== true && imap_secure !== false) || !smtp_host || !smtp_port || (smtp_secure !== true && smtp_secure !== false)) {
      return res.status(400).json({ error: 'Todos os campos são obrigatórios.' });
    }

    console.log(`[VALIDAÇÃO] Testando credenciais IMAP para ${email}...`);
    await validateImapCredentials(req.body);
    console.log(`[VALIDAÇÃO] Credenciais IMAP para ${email} são válidas.`);

    console.log(`[VALIDAÇÃO] Testando credenciais SMTP para ${email}...`);
    await validateSmtpCredentials(req.body);
    console.log(`[VALIDAÇÃO] Credenciais SMTP para ${email} são válidas.`);

    const instanceId = INSTANCE_ID;
    console.log(`[API] Atribuindo nova mailbox para a instância fixa: ${instanceId}`);

    const newMailboxData = { ...req.body, instance_id: instanceId };

    console.log(`[INFO] Credenciais validadas. Inserindo mailbox ${email} no banco de dados...`);
    const { data, error } = await supabase
      .from('mailboxes')
      .insert([newMailboxData])
      .select('id, email, created_at')
      .single();

    if (error) throw error;

    res.status(201).json({ message: `Mailbox adicionada e atribuída à instância ${instanceId}!`, data });

  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Este e-mail já está cadastrado.', details: error.message });
    }

    if (error.message.includes('Falha na validação')) {
      console.error(`[VALIDAÇÃO] Erro: ${error.message}`);
      return res.status(400).json({ error: 'Credenciais inválidas.', details: error.message });
    }

    console.error(`[ERRO GERAL] Falha ao adicionar mailbox: ${error.message}`);
    res.status(500).json({ error: 'Erro interno ao adicionar mailbox', details: error.message });
  }
});

app.delete('/api/mailboxes/:email', async (req, res) => {
  const { email } = req.params;
  try {
    const { error } = await supabase.from('mailboxes').delete().eq('email', email);

    if (error) throw error;

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ error: `Erro ao deletar mailbox ${email}`, details: error.message });
  }
});

app.get('/api/mailboxes/:email/emails', async (req, res) => {
  const { email } = req.params;
  const page = parseInt(req.query.page, 10) || 1;
  const limit = parseInt(req.query.limit, 10) || 20;
  const offset = (page - 1) * limit;

  try {
    const { data: mailData } = await supabase.from('mailboxes').select('id').eq('email', email).single();
    const { data, error, count } = await supabase
      .from('emails')
      .select('*', { count: 'exact' })
      .eq('mailbox_id', mailData.id)
      .order('received_at', { ascending: false })
      .range(offset, offset + limit - 1);

    if (error) throw error;

    res.json({
      data,
      pagination: {
        totalItems: count,
        totalPages: Math.ceil(count / limit),
        currentPage: page,
        limit: limit
      }
    });
  } catch (error) {
    res.status(500).json({ error: `Erro ao buscar e-mails para a mailbox ${email}`, details: error.message });
  }
});

app.post('/api/send', async (req, res) => {
  const { from, to, subject, text, html, requestReadReceipt } = req.body;

  if (!from || !to || !subject || (!text && !html)) {
    return res.status(400).json({ error: 'Os campos "from", "to", "subject" e ("text" ou "html") são obrigatórios.' });
  }

  try {
    const { data: mailbox, error: dbError } = await supabase
      .from('mailboxes')
      .select('email, smtp_host, smtp_port, password')
      .eq('email', from)
      .single();

    if (dbError || !mailbox) {
      return res.status(404).json({ error: `Mailbox de origem "${from}" não encontrada ou não configurada para envio.` });
    }

    const transporter = nodemailer.createTransport({
      host: mailbox.smtp_host,
      port: mailbox.smtp_port || 465,
      secure: (mailbox.smtp_port || 465) === 465,
      auth: {
        user: mailbox.email,
        pass: mailbox.password,
      },
    });

    const mailOptions = {
      from: from,
      to: to,
      subject: subject,
      text: text,
      html: html,
    };

    if (requestReadReceipt === true) {
      mailOptions.headers = {
        'Disposition-Notification-To': from
      };
    }

    const info = await transporter.sendMail(mailOptions);
    console.log(`E-mail enviado: ${info.messageId}`);
    res.status(202).json({ success: true, message: 'E-mail enviado para a fila de processamento.', messageId: info.messageId });
  } catch (error) {
    console.error('Erro ao enviar e-mail:', error);
    res.status(500).json({ success: false, error: 'Falha ao enviar o e-mail.', details: error.message });
  }
});

app.get('/test/list-mailboxes', (req, res) => {
  try {
    const mailboxes = Array.from(managedMailboxes.entries()).map(([id, manager]) => ({
      id,
      email: manager.credentials.email,
      connected: manager.client && !manager.client.closed,
      isPolling: manager.isPolling,
      lastChecked: new Date(manager.lastChecked).toISOString()
    }));

    res.status(200).json({ mailboxes });
  } catch (error) {
    res.status(500).json({ error: 'Erro ao listar mailboxes', details: error.message });
  }
});

app.post('/test/force-disconnect/:mailboxId', (req, res) => {
  try {
    const mailboxId = parseInt(req.params.mailboxId, 10);
    const emailFilter = req.query.email;

    const manager = managedMailboxes.get(mailboxId);

    if (!manager) {
      return res.status(404).json({
        success: false,
        error: `Mailbox ${mailboxId} nao encontrada em managedMailboxes`,
        available_mailboxes: Array.from(managedMailboxes.keys())
      });
    }

    if (emailFilter && manager.credentials.email !== emailFilter) {
      return res.status(400).json({
        success: false,
        error: `Email nao corresponde. Esperado: ${manager.credentials.email}, Recebido: ${emailFilter}`
      });
    }

    if (!manager.client || manager.client.closed) {
      return res.status(400).json({
        success: false,
        mailboxId,
        email: manager.credentials.email,
        error: 'Cliente ja esta desconectado ou nulo'
      });
    }

    manager.client.close();
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      level: 'TEST',
      mailboxId: manager.credentials.id,
      email: manager.credentials.email,
      message: 'Cliente IMAP fechado forcadamente via endpoint de teste.'
    }));

    res.status(200).json({
      success: true,
      mailboxId,
      email: manager.credentials.email,
      action: 'connection_forced_closed',
      message: 'Cliente IMAP desconectado forcadamente. Aguarde polling detectar erro (~5-20s).'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Erro ao forcar desconexao',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Servidor de API rodando na porta ${PORT}`);
  console.log(`Novas mailboxes serão atribuídas à instância: ${INSTANCE_ID}`);
});