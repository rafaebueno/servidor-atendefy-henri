require('dotenv').config();
const axios = require('axios');

/**
 * Script de teste para simular envio de webhook
 *
 * Uso:
 * 1. node test-webhook.js                    (teste básico)
 * 2. node test-webhook.js example@email.com  (teste com email específico)
 */

const WEBHOOK_URL = process.env.WEBHOOK_URL;

if (!WEBHOOK_URL) {
  console.error('❌ ERRO: WEBHOOK_URL não configurada no .env');
  process.exit(1);
}

// Payload de exemplo (simula email da caixa problemática)
const testPayload = {
  client_id: process.argv[2] || 'test@example.com',
  from: 'sender@example.com',
  to: 'recipient@example.com',
  subject: 'Teste de webhook - ' + new Date().toISOString(),
  message_id: 'test-' + Date.now() + '@test.local',
  date: new Date().toISOString(),
  original_from: 'original@example.com',
  text: 'Este é um email de teste para validar o webhook.',
  html: '<p>Este é um email de teste para validar o webhook.</p>'
};

console.log('📤 Testando envio de webhook...\n');
console.log('URL:', WEBHOOK_URL);
console.log('Payload size:', JSON.stringify(testPayload).length, 'bytes');
console.log('Client ID:', testPayload.client_id);
console.log('\n---\n');

const startTime = Date.now();

axios.post(WEBHOOK_URL, testPayload, {
  timeout: 30000,
  headers: {
    'Content-Type': 'application/json'
  },
  validateStatus: function (status) {
    return status >= 200 && status < 600; // Aceita qualquer status
  }
})
  .then(response => {
    const duration = Date.now() - startTime;

    console.log('✅ SUCESSO!');
    console.log('Status:', response.status, response.statusText);
    console.log('Tempo:', duration, 'ms');
    console.log('Response headers:', JSON.stringify(response.headers, null, 2));
    console.log('Response data:', JSON.stringify(response.data, null, 2));

    if (response.status >= 200 && response.status < 300) {
      console.log('\n✅ N8N aceitou o webhook com sucesso!');
    } else {
      console.log('\n⚠️  N8N retornou status não-sucesso:', response.status);
    }
  })
  .catch(error => {
    const duration = Date.now() - startTime;

    console.log('❌ ERRO ao enviar webhook!');
    console.log('Tempo:', duration, 'ms');
    console.log('Error code:', error.code);
    console.log('Error message:', error.message);

    if (error.response) {
      console.log('\n📥 Resposta HTTP recebida:');
      console.log('Status:', error.response.status, error.response.statusText);
      console.log('Headers:', JSON.stringify(error.response.headers, null, 2));
      console.log('Data:', JSON.stringify(error.response.data, null, 2));
    } else if (error.request) {
      console.log('\n⚠️  Requisição enviada mas sem resposta!');
      console.log('Possíveis causas:');
      console.log('- Timeout (>30s)');
      console.log('- N8N offline ou inacessível');
      console.log('- Firewall bloqueando');
      console.log('- Problema de rede/DNS');
    } else {
      console.log('\n⚠️  Erro ao preparar requisição:', error.message);
    }

    process.exit(1);
  });
