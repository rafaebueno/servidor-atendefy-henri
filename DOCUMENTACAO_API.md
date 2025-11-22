# Documentação API - Mailbox Manager

## Sumário
1. [Informações Gerais](#informações-gerais)
2. [Autenticação](#autenticação)
3. [Endpoints de Health Check](#endpoints-de-health-check)
4. [Endpoints de Mailboxes](#endpoints-de-mailboxes)
5. [Endpoints de E-mails](#endpoints-de-e-mails)
6. [Endpoints de Envio](#endpoints-de-envio)
7. [Endpoints de Teste](#endpoints-de-teste)
8. [Tratamento de Erros](#tratamento-de-erros)
9. [Códigos de Status HTTP](#códigos-de-status-http)

---

## Informações Gerais

**Base URL:** `http://localhost:3000` (padrão) ou configurado via `PORT` no `.env`

**Formato de Dados:** JSON

**Headers Obrigatórios:**
- `Content-Type: application/json`
- `Authorization: Bearer {TOKEN}` (exceto endpoint `/health/live`)

---

## Autenticação

Todos os endpoints (exceto `/health/live`) requerem autenticação via Bearer Token.

### Configuração
Configure o token no arquivo `.env`:
```
API_BEARER_TOKEN=seu_token_secreto_aqui
```

### Como Usar
Inclua o header em todas as requisições:
```
Authorization: Bearer seu_token_secreto_aqui
```

### Exemplo de Erro de Autenticação

**Request:**
```http
GET /api/mailboxes HTTP/1.1
Host: localhost:3000
```

**Response:**
```json
{
  "error": "Unauthorized",
  "message": "Token invalido ou ausente. Use: Authorization: Bearer TOKEN"
}
```
**Status Code:** `401 Unauthorized`

---

## Endpoints de Health Check

### 1. Health Check Simples

Verifica se a API está respondendo.

**Endpoint:** `GET /health/live`

**Autenticação:** Não requerida

**Exemplo de Request (Postman):**
```http
GET /health/live HTTP/1.1
Host: localhost:3000
```

**Exemplo de Response:**
```json
{
  "status": "alive"
}
```
**Status Code:** `200 OK`

---

### 2. Health Check de Mailbox Específica

Verifica o status de sincronização de uma mailbox específica.

**Endpoint:** `GET /health/:email`

**Autenticação:** Requerida

**Parâmetros de URL:**
- `email` (string, obrigatório): E-mail da mailbox a verificar

**Exemplo de Request (Postman):**
```http
GET /health/usuario@example.com HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Exemplo de Response - Mailbox Pronta:**
```json
{
  "status": "ready",
  "last_synced_at": "2025-01-20T14:30:00.000Z"
}
```
**Status Code:** `200 OK`

**Condição:** Última sincronização ocorreu há menos de 5 minutos.

---

**Exemplo de Response - Mailbox Não Pronta:**
```json
{
  "status": "not_ready",
  "last_synced_at": "2025-01-20T13:00:00.000Z"
}
```
**Status Code:** `200 OK`

**Condição:** Última sincronização há mais de 5 minutos ou nunca sincronizada.

---

**Exemplo de Response - Mailbox Não Encontrada:**
```json
{
  "status": "not_found",
  "message": "Mailbox not found."
}
```
**Status Code:** `404 Not Found`

---

**Exemplo de Response - Erro de Banco de Dados:**
```json
{
  "status": "not_ready",
  "dependencies": {
    "database": "error",
    "details": "Mensagem de erro específica"
  }
}
```
**Status Code:** `503 Service Unavailable`

---

## Endpoints de Mailboxes

### 1. Listar Todas as Mailboxes

Retorna lista de todas as mailboxes cadastradas.

**Endpoint:** `GET /api/mailboxes`

**Autenticação:** Requerida

**Exemplo de Request (Postman):**
```http
GET /api/mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json
```

**Exemplo de Response:**
```json
[
  {
    "id": 1,
    "email": "usuario1@example.com",
    "active": true,
    "imap_host": "imap.gmail.com",
    "smtp_host": "smtp.gmail.com",
    "created_at": "2025-01-15T10:00:00.000Z"
  },
  {
    "id": 2,
    "email": "usuario2@example.com",
    "active": true,
    "imap_host": "outlook.office365.com",
    "smtp_host": "smtp.office365.com",
    "created_at": "2025-01-16T12:30:00.000Z"
  }
]
```
**Status Code:** `200 OK`

**Exemplo de Response - Erro:**
```json
{
  "error": "Erro ao buscar mailboxes",
  "details": "Mensagem de erro específica"
}
```
**Status Code:** `500 Internal Server Error`

---

### 2. Adicionar Nova Mailbox

Cadastra uma nova mailbox com validação de credenciais IMAP e SMTP.

**Endpoint:** `POST /api/mailboxes`

**Autenticação:** Requerida

**Body Parameters:**
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `email` | string | Sim | Endereço de e-mail |
| `password` | string | Sim | Senha da conta |
| `imap_host` | string | Sim | Host do servidor IMAP |
| `imap_port` | number | Sim | Porta IMAP (ex: 993) |
| `imap_secure` | boolean | Sim | Usar TLS/SSL para IMAP |
| `smtp_host` | string | Sim | Host do servidor SMTP |
| `smtp_port` | number | Sim | Porta SMTP (ex: 465, 587) |
| `smtp_secure` | boolean | Sim | Usar TLS/SSL para SMTP |

**Exemplo de Request (Postman):**
```http
POST /api/mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json

{
  "email": "novaconta@gmail.com",
  "password": "senha_app_aqui",
  "imap_host": "imap.gmail.com",
  "imap_port": 993,
  "imap_secure": true,
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 465,
  "smtp_secure": true
}
```

**Exemplo de Response - Sucesso:**
```json
{
  "message": "Mailbox adicionada e atribuída à instância 1!",
  "data": {
    "id": 3,
    "email": "novaconta@gmail.com",
    "created_at": "2025-01-20T15:00:00.000Z"
  }
}
```
**Status Code:** `201 Created`

**Fluxo de Processamento:**
1. Validação dos campos obrigatórios
2. Teste de conexão IMAP com as credenciais
3. Teste de conexão SMTP com as credenciais
4. Inserção no banco de dados com atribuição de instância
5. Worker iniciará sincronização automaticamente

---

**Exemplo de Response - Campos Faltando:**
```json
{
  "error": "Todos os campos são obrigatórios."
}
```
**Status Code:** `400 Bad Request`

---

**Exemplo de Response - E-mail Já Cadastrado:**
```json
{
  "error": "Este e-mail já está cadastrado.",
  "details": "duplicate key value violates unique constraint..."
}
```
**Status Code:** `409 Conflict`

---

**Exemplo de Response - Credenciais IMAP Inválidas:**
```json
{
  "error": "Credenciais inválidas.",
  "details": "Falha na validação IMAP: Invalid credentials"
}
```
**Status Code:** `400 Bad Request`

---

**Exemplo de Response - Credenciais SMTP Inválidas:**
```json
{
  "error": "Credenciais inválidas.",
  "details": "Falha na validação SMTP: Authentication failed"
}
```
**Status Code:** `400 Bad Request`

---

### Exemplos de Configuração por Provedor

**Gmail:**
```json
{
  "email": "usuario@gmail.com",
  "password": "senha_app_16_caracteres",
  "imap_host": "imap.gmail.com",
  "imap_port": 993,
  "imap_secure": true,
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 465,
  "smtp_secure": true
}
```
**Nota:** Gmail requer "Senha de App" se 2FA estiver ativo.

---

**Outlook/Office 365:**
```json
{
  "email": "usuario@outlook.com",
  "password": "sua_senha",
  "imap_host": "outlook.office365.com",
  "imap_port": 993,
  "imap_secure": true,
  "smtp_host": "smtp.office365.com",
  "smtp_port": 587,
  "smtp_secure": false
}
```

---

**Yahoo Mail:**
```json
{
  "email": "usuario@yahoo.com",
  "password": "senha_app_yahoo",
  "imap_host": "imap.mail.yahoo.com",
  "imap_port": 993,
  "imap_secure": true,
  "smtp_host": "smtp.mail.yahoo.com",
  "smtp_port": 465,
  "smtp_secure": true
}
```

---

### 3. Deletar Mailbox

Remove uma mailbox cadastrada.

**Endpoint:** `DELETE /api/mailboxes/:email`

**Autenticação:** Requerida

**Parâmetros de URL:**
- `email` (string, obrigatório): E-mail da mailbox a deletar

**Exemplo de Request (Postman):**
```http
DELETE /api/mailboxes/usuario@example.com HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Exemplo de Response - Sucesso:**
```
(Sem corpo de resposta)
```
**Status Code:** `204 No Content`

**Efeitos:**
- Mailbox removida do banco de dados
- Worker interrompe sincronização automaticamente
- E-mails já sincronizados permanecem no banco (se houver constraints apropriadas)

---

**Exemplo de Response - Erro:**
```json
{
  "error": "Erro ao deletar mailbox usuario@example.com",
  "details": "Mensagem de erro específica"
}
```
**Status Code:** `500 Internal Server Error`

---

## Endpoints de E-mails

### 1. Listar E-mails de uma Mailbox

Retorna e-mails recebidos em uma mailbox com paginação.

**Endpoint:** `GET /api/mailboxes/:email/emails`

**Autenticação:** Requerida

**Parâmetros de URL:**
- `email` (string, obrigatório): E-mail da mailbox

**Query Parameters:**
| Parâmetro | Tipo | Obrigatório | Padrão | Descrição |
|-----------|------|-------------|--------|-----------|
| `page` | number | Não | 1 | Número da página |
| `limit` | number | Não | 20 | Itens por página |

**Exemplo de Request (Postman):**
```http
GET /api/mailboxes/usuario@example.com/emails?page=1&limit=10 HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json
```

**Exemplo de Response:**
```json
{
  "data": [
    {
      "id": 145,
      "mailbox_id": 1,
      "email": "usuario@example.com",
      "message_id": "<abc123@mail.example.com>",
      "uid": 5023,
      "sender": {
        "address": "remetente@example.com",
        "name": "Nome do Remetente"
      },
      "recipients": [
        {
          "address": "usuario@example.com",
          "name": "Destinatário"
        }
      ],
      "subject": "Assunto do E-mail",
      "body_text": "Texto plano do e-mail...",
      "body_html": "<p>HTML do e-mail...</p>",
      "received_at": "2025-01-20T14:25:00.000Z",
      "has_attachments": false,
      "original_from": "remetente@example.com",
      "raw_headers": {
        "date": ["Mon, 20 Jan 2025 14:25:00 +0000"],
        "from": ["remetente@example.com"],
        "to": ["usuario@example.com"]
      }
    }
  ],
  "pagination": {
    "totalItems": 532,
    "totalPages": 54,
    "currentPage": 1,
    "limit": 10
  }
}
```
**Status Code:** `200 OK`

**Observações:**
- E-mails ordenados por `received_at` (mais recentes primeiro)
- `body_html` pode ser `null` se e-mail for apenas texto
- `original_from` capturado do header `Return-Path`

---

**Exemplo de Response - Erro:**
```json
{
  "error": "Erro ao buscar e-mails para a mailbox usuario@example.com",
  "details": "Mensagem de erro específica"
}
```
**Status Code:** `500 Internal Server Error`

---

## Endpoints de Envio

### 1. Enviar E-mail

Envia e-mail através de uma mailbox cadastrada.

**Endpoint:** `POST /api/send`

**Autenticação:** Requerida

**Body Parameters:**
| Campo | Tipo | Obrigatório | Descrição |
|-------|------|-------------|-----------|
| `from` | string | Sim | E-mail remetente (deve estar cadastrado) |
| `to` | string | Sim | E-mail destinatário |
| `subject` | string | Sim | Assunto do e-mail |
| `text` | string | Condicional* | Corpo em texto plano |
| `html` | string | Condicional* | Corpo em HTML |
| `requestReadReceipt` | boolean | Não | Solicitar confirmação de leitura |

**\*Nota:** Pelo menos um de `text` ou `html` deve ser fornecido.

**Exemplo de Request (Postman) - Texto Simples:**
```http
POST /api/send HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json

{
  "from": "minhaconta@gmail.com",
  "to": "destinatario@example.com",
  "subject": "Teste de Envio",
  "text": "Este é um e-mail de teste enviado via API."
}
```

**Exemplo de Request - HTML com Confirmação de Leitura:**
```http
POST /api/send HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json

{
  "from": "minhaconta@gmail.com",
  "to": "destinatario@example.com",
  "subject": "E-mail com HTML",
  "html": "<h1>Olá!</h1><p>Este é um <strong>e-mail HTML</strong>.</p>",
  "text": "Versão em texto plano para clientes que não suportam HTML",
  "requestReadReceipt": true
}
```

**Exemplo de Response - Sucesso:**
```json
{
  "success": true,
  "message": "E-mail enviado para a fila de processamento.",
  "messageId": "<1234567890.123456.789012345678901@gmail.com>"
}
```
**Status Code:** `202 Accepted`

**Observações:**
- `messageId` é o identificador único do e-mail gerado pelo servidor SMTP
- Envio é assíncrono; `202` indica que foi aceito para processamento

---

**Exemplo de Response - Campos Obrigatórios Faltando:**
```json
{
  "error": "Os campos \"from\", \"to\", \"subject\" e (\"text\" ou \"html\") são obrigatórios."
}
```
**Status Code:** `400 Bad Request`

---

**Exemplo de Response - Mailbox Não Encontrada:**
```json
{
  "error": "Mailbox de origem \"minhaconta@gmail.com\" não encontrada ou não configurada para envio."
}
```
**Status Code:** `404 Not Found`

---

**Exemplo de Response - Erro de Envio:**
```json
{
  "success": false,
  "error": "Falha ao enviar o e-mail.",
  "details": "Authentication failed"
}
```
**Status Code:** `500 Internal Server Error`

**Causas Comuns:**
- Credenciais SMTP incorretas
- Servidor SMTP temporariamente indisponível
- Limite de envio excedido pelo provedor
- Destinatário inválido ou bloqueado

---

## Endpoints de Teste

### 1. Listar Mailboxes Ativas no Worker

Lista mailboxes gerenciadas pelo worker com status de conexão.

**Endpoint:** `GET /test/list-mailboxes`

**Autenticação:** Requerida

**Uso:** Diagnóstico e monitoramento

**Exemplo de Request (Postman):**
```http
GET /test/list-mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Exemplo de Response:**
```json
{
  "mailboxes": [
    {
      "id": 1,
      "email": "usuario1@gmail.com",
      "connected": true,
      "isPolling": false,
      "lastChecked": "2025-01-20T15:10:30.000Z"
    },
    {
      "id": 2,
      "email": "usuario2@outlook.com",
      "connected": false,
      "isPolling": false,
      "lastChecked": "2025-01-20T15:08:15.000Z"
    }
  ]
}
```
**Status Code:** `200 OK`

**Campos:**
- `connected`: Conexão IMAP está ativa
- `isPolling`: Está atualmente verificando novos e-mails
- `lastChecked`: Timestamp da última verificação

---

**Exemplo de Response - Erro:**
```json
{
  "error": "Erro ao listar mailboxes",
  "details": "Mensagem de erro específica"
}
```
**Status Code:** `500 Internal Server Error`

---

### 2. Forçar Desconexão IMAP

Força fechamento da conexão IMAP de uma mailbox (para testes de reconexão).

**Endpoint:** `POST /test/force-disconnect/:mailboxId`

**Autenticação:** Requerida

**Parâmetros de URL:**
- `mailboxId` (number, obrigatório): ID numérico da mailbox

**Query Parameters:**
| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `email` | string | Não | Validação adicional do e-mail |

**Exemplo de Request (Postman):**
```http
POST /test/force-disconnect/1?email=usuario@gmail.com HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Exemplo de Response - Sucesso:**
```json
{
  "success": true,
  "mailboxId": 1,
  "email": "usuario@gmail.com",
  "action": "connection_forced_closed",
  "message": "Cliente IMAP desconectado forcadamente. Aguarde polling detectar erro (~5-20s)."
}
```
**Status Code:** `200 OK`

**Efeitos:**
- Conexão IMAP fechada imediatamente
- Worker detectará desconexão no próximo polling
- Reconexão automática será tentada após ~30 segundos

---

**Exemplo de Response - Mailbox Não Encontrada:**
```json
{
  "success": false,
  "error": "Mailbox 99 nao encontrada em managedMailboxes",
  "available_mailboxes": [1, 2, 3]
}
```
**Status Code:** `404 Not Found`

---

**Exemplo de Response - E-mail Não Corresponde:**
```json
{
  "success": false,
  "error": "Email nao corresponde. Esperado: usuario@gmail.com, Recebido: outro@example.com"
}
```
**Status Code:** `400 Bad Request`

---

**Exemplo de Response - Já Desconectado:**
```json
{
  "success": false,
  "mailboxId": 1,
  "email": "usuario@gmail.com",
  "error": "Cliente ja esta desconectado ou nulo"
}
```
**Status Code:** `400 Bad Request`

---

**Exemplo de Response - Erro:**
```json
{
  "success": false,
  "error": "Erro ao forcar desconexao",
  "details": "Mensagem de erro específica"
}
```
**Status Code:** `500 Internal Server Error`

---

## Tratamento de Erros

### Categorias de Erros

#### 1. Erros de Validação (400 Bad Request)
**Causas:**
- Campos obrigatórios ausentes
- Tipos de dados incorretos
- Valores inválidos (ex: `imap_secure` não booleano)
- Credenciais IMAP/SMTP inválidas

**Exemplo:**
```json
{
  "error": "Todos os campos são obrigatórios."
}
```

**Ação Sugerida:**
- Verificar todos os campos obrigatórios
- Validar tipos de dados
- Confirmar credenciais com provedor de e-mail

---

#### 2. Erros de Autenticação (401 Unauthorized)
**Causas:**
- Token Bearer ausente
- Token inválido ou expirado

**Exemplo:**
```json
{
  "error": "Unauthorized",
  "message": "Token invalido ou ausente. Use: Authorization: Bearer TOKEN"
}
```

**Ação Sugerida:**
- Incluir header `Authorization: Bearer {TOKEN}`
- Verificar valor do token no `.env`
- Confirmar que o token está correto

---

#### 3. Erros de Não Encontrado (404 Not Found)
**Causas:**
- Mailbox não existe no banco
- E-mail especificado não cadastrado
- Recurso solicitado não disponível

**Exemplo:**
```json
{
  "status": "not_found",
  "message": "Mailbox not found."
}
```

**Ação Sugerida:**
- Verificar se o e-mail está cadastrado
- Confirmar ortografia do e-mail
- Listar mailboxes disponíveis com `GET /api/mailboxes`

---

#### 4. Erros de Conflito (409 Conflict)
**Causas:**
- E-mail já cadastrado no sistema
- Tentativa de duplicação de recurso

**Exemplo:**
```json
{
  "error": "Este e-mail já está cadastrado.",
  "details": "duplicate key value violates unique constraint..."
}
```

**Ação Sugerida:**
- Verificar se mailbox já existe
- Usar `PUT` ou `PATCH` para atualizar (se implementado)
- Deletar mailbox existente antes de recriar

---

#### 5. Erros Internos (500 Internal Server Error)
**Causas:**
- Falha de conexão com banco de dados
- Erro inesperado no processamento
- Falha de comunicação com servidor SMTP/IMAP

**Exemplo:**
```json
{
  "error": "Erro interno ao adicionar mailbox",
  "details": "Connection timeout"
}
```

**Ação Sugerida:**
- Verificar logs do servidor
- Confirmar que Supabase está acessível
- Tentar novamente após alguns segundos
- Contatar administrador se persistir

---

#### 6. Erros de Serviço Indisponível (503 Service Unavailable)
**Causas:**
- Banco de dados inacessível
- Dependências externas falhando

**Exemplo:**
```json
{
  "status": "not_ready",
  "dependencies": {
    "database": "error",
    "details": "Connection refused"
  }
}
```

**Ação Sugerida:**
- Aguardar recuperação do serviço
- Verificar status do Supabase
- Confirmar variáveis de ambiente

---

### Estrutura Padrão de Erros

Todos os erros seguem a estrutura:

```json
{
  "error": "Descrição breve do erro",
  "details": "Mensagem técnica detalhada (opcional)"
}
```

Ou para erros de health:

```json
{
  "status": "not_ready|not_found|error",
  "message": "Descrição do problema (opcional)",
  "dependencies": {
    "database": "error",
    "details": "Informações técnicas"
  }
}
```

---

## Códigos de Status HTTP

| Código | Nome | Uso na API |
|--------|------|------------|
| 200 | OK | Operação bem-sucedida (GET) |
| 201 | Created | Recurso criado (POST mailbox) |
| 202 | Accepted | Requisição aceita para processamento (envio de e-mail) |
| 204 | No Content | Deleção bem-sucedida |
| 400 | Bad Request | Validação falhou ou dados inválidos |
| 401 | Unauthorized | Autenticação ausente ou inválida |
| 404 | Not Found | Recurso não encontrado |
| 409 | Conflict | Conflito (e-mail duplicado) |
| 500 | Internal Server Error | Erro interno do servidor |
| 503 | Service Unavailable | Serviço ou dependência indisponível |

---

## Casos de Uso Comuns

### Caso 1: Cadastrar e Monitorar Nova Mailbox

**Passo 1:** Adicionar mailbox
```http
POST /api/mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json

{
  "email": "novaconta@gmail.com",
  "password": "senha_app",
  "imap_host": "imap.gmail.com",
  "imap_port": 993,
  "imap_secure": true,
  "smtp_host": "smtp.gmail.com",
  "smtp_port": 465,
  "smtp_secure": true
}
```

**Passo 2:** Aguardar 1-2 minutos para primeira sincronização

**Passo 3:** Verificar status
```http
GET /health/novaconta@gmail.com HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Passo 4:** Listar e-mails sincronizados
```http
GET /api/mailboxes/novaconta@gmail.com/emails?page=1&limit=20 HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

---

### Caso 2: Enviar E-mail e Verificar Resposta

**Passo 1:** Enviar e-mail
```http
POST /api/send HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
Content-Type: application/json

{
  "from": "minhaconta@gmail.com",
  "to": "cliente@example.com",
  "subject": "Proposta Comercial",
  "html": "<h1>Proposta</h1><p>Segue em anexo...</p>",
  "text": "Proposta - Segue em anexo...",
  "requestReadReceipt": true
}
```

**Passo 2:** Aguardar resposta do destinatário

**Passo 3:** Verificar novos e-mails
```http
GET /api/mailboxes/minhaconta@gmail.com/emails?page=1&limit=5 HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

---

### Caso 3: Diagnóstico de Problemas de Conexão

**Passo 1:** Verificar mailboxes ativas no worker
```http
GET /test/list-mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Passo 2:** Se `connected: false`, forçar reconexão
```http
POST /test/force-disconnect/1 HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

**Passo 3:** Aguardar 30-60 segundos para reconexão automática

**Passo 4:** Verificar novamente
```http
GET /test/list-mailboxes HTTP/1.1
Host: localhost:3000
Authorization: Bearer seu_token_aqui
```

---

## Webhooks

### Configuração

Configure URL do webhook no `.env`:
```
WEBHOOK_URL=https://seu-servidor.com/webhook/emails
```

### Payload Enviado

Quando um novo e-mail é recebido, o sistema envia:

```json
{
  "client_id": "usuario@example.com",
  "from": "remetente@example.com",
  "to": "usuario@example.com",
  "subject": "Assunto do E-mail",
  "message_id": "<abc123@mail.example.com>",
  "date": "2025-01-20T14:25:00.000Z",
  "original_from": "remetente@example.com",
  "text": "Corpo em texto plano...",
  "html": "<p>Corpo HTML...</p>"
}
```

**Método:** `POST`

**Headers:**
- `Content-Type: application/json`

### Tratamento de Falhas

- Se webhook retornar erro, tentativa não é repetida
- Falha é registrada nos logs do worker
- E-mail é salvo no banco independentemente do webhook

---

## Logs e Monitoramento

### Estrutura dos Logs

Logs são emitidos em formato JSON:

```json
{
  "timestamp": "2025-01-20T15:30:45.000Z",
  "level": "INFO",
  "instanceId": 1,
  "mailboxId": 1,
  "email": "usuario@example.com",
  "message": "Conexão IMAP estabelecida."
}
```

### Níveis de Log

- `INFO`: Operações normais
- `WARN`: Situações anormais não críticas
- `ERROR`: Erros que requerem atenção
- `TEST`: Ações de endpoints de teste

### Eventos Importantes

**Conexão:**
```
Conexão IMAP estabelecida.
```

**Sincronização:**
```
5 novo(s) e-mail(s).
Nenhum novo e-mail.
```

**Erros:**
```
Erro IMAP capturado antes do close.
Conexão IMAP fechada inesperadamente.
Falha ao enviar webhook.
```

---

## Variáveis de Ambiente

Arquivo `.env` necessário:

```env
# API
PORT=3000
API_BEARER_TOKEN=seu_token_secreto_aqui

# Supabase
SUPABASE_URL=https://seu-projeto.supabase.co
SUPABASE_KEY=sua_chave_aqui

# Worker
INSTANCE_ID=1

# Webhook (opcional)
WEBHOOK_URL=https://seu-servidor.com/webhook
```

---

## Limitações e Considerações

### Performance
- Polling a cada ~20 segundos por mailbox
- Limite de ~50 mailboxes por instância recomendado
- Paginação padrão: 20 itens

### Segurança
- Senhas armazenadas em texto plano no banco
- Bearer token estático (sem rotação automática)
- Sem rate limiting implementado

### Funcionamento
- Worker e API devem rodar separadamente
- Reconexão automática após falhas (~30s delay)
- E-mails duplicados ignorados (baseado em `message_id`)

### Provedores de E-mail
- Gmail: Requer "Senha de App" com 2FA
- Outlook: Pode requerer "Permitir aplicativos menos seguros"
- Yahoo: Requer "Senha de App"

---

## Troubleshooting

### Problema: "Credenciais inválidas" ao adicionar mailbox

**Verificar:**
1. Senha de App gerada (se 2FA ativo)
2. IMAP/SMTP habilitados na conta
3. Host e porta corretos para provedor
4. Firewall não bloqueando portas 993/465/587

---

### Problema: Mailbox não sincroniza

**Verificar:**
1. Worker está rodando (`pm2 status`)
2. Mailbox está `active: true` no banco
3. `instance_id` corresponde ao worker
4. Logs do worker para erros

---

### Problema: E-mails não aparecem na API

**Verificar:**
1. Health check mostra `status: ready`
2. `last_synced_at` atualizado recentemente
3. E-mails existem na INBOX (não em outras pastas)
4. Banco de dados acessível

---

### Problema: Envio de e-mail falha

**Verificar:**
1. Mailbox remetente cadastrada
2. Credenciais SMTP válidas
3. Limite de envio do provedor não excedido
4. Destinatário válido e não bloqueado

---

## Exemplos Completos com cURL

Esta seção contém exemplos prontos para uso com `curl` que podem ser copiados diretamente para o terminal ou Postman.

### Configuração Inicial

**Defina suas variáveis:**
```bash
# Windows PowerShell
$BASE_URL = "http://localhost:3000"
$TOKEN = "seu_token_aqui"

# Linux/Mac
export BASE_URL="http://localhost:3000"
export TOKEN="seu_token_aqui"
```

---

### Health Check

**1. Health Check Simples (sem autenticação):**
```bash
# Windows PowerShell
curl http://localhost:3000/health/live

# Linux/Mac
curl http://localhost:3000/health/live
```

**2. Health Check de Mailbox Específica:**
```bash
# Windows PowerShell
curl -H "Authorization: Bearer $TOKEN" `
  http://localhost:3000/health/usuario@example.com

# Linux/Mac
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/health/usuario@example.com
```

---

### Gerenciamento de Mailboxes

**3. Listar Todas as Mailboxes:**
```bash
# Windows PowerShell
curl -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  http://localhost:3000/api/mailboxes

# Linux/Mac
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  http://localhost:3000/api/mailboxes
```

**4. Adicionar Nova Mailbox (Gmail):**
```bash
# Windows PowerShell
curl -X POST http://localhost:3000/api/mailboxes `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{
    \"email\": \"novaconta@gmail.com\",
    \"password\": \"senha_app_16_caracteres\",
    \"imap_host\": \"imap.gmail.com\",
    \"imap_port\": 993,
    \"imap_secure\": true,
    \"smtp_host\": \"smtp.gmail.com\",
    \"smtp_port\": 465,
    \"smtp_secure\": true
  }'

# Linux/Mac
curl -X POST http://localhost:3000/api/mailboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "novaconta@gmail.com",
    "password": "senha_app_16_caracteres",
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "imap_secure": true,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 465,
    "smtp_secure": true
  }'
```

**5. Adicionar Nova Mailbox (Outlook):**
```bash
# Windows PowerShell
curl -X POST http://localhost:3000/api/mailboxes `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{
    \"email\": \"usuario@outlook.com\",
    \"password\": \"sua_senha\",
    \"imap_host\": \"outlook.office365.com\",
    \"imap_port\": 993,
    \"imap_secure\": true,
    \"smtp_host\": \"smtp.office365.com\",
    \"smtp_port\": 587,
    \"smtp_secure\": false
  }'

# Linux/Mac
curl -X POST http://localhost:3000/api/mailboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "usuario@outlook.com",
    "password": "sua_senha",
    "imap_host": "outlook.office365.com",
    "imap_port": 993,
    "imap_secure": true,
    "smtp_host": "smtp.office365.com",
    "smtp_port": 587,
    "smtp_secure": false
  }'
```

**6. Deletar Mailbox:**
```bash
# Windows PowerShell
curl -X DELETE http://localhost:3000/api/mailboxes/usuario@example.com `
  -H "Authorization: Bearer $TOKEN"

# Linux/Mac
curl -X DELETE http://localhost:3000/api/mailboxes/usuario@example.com \
  -H "Authorization: Bearer $TOKEN"
```

---

### Consulta de E-mails

**7. Listar E-mails (primeira página, 20 itens):**
```bash
# Windows PowerShell
curl -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  "http://localhost:3000/api/mailboxes/usuario@example.com/emails?page=1&limit=20"

# Linux/Mac
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "http://localhost:3000/api/mailboxes/usuario@example.com/emails?page=1&limit=20"
```

**8. Listar E-mails (página 2, 10 itens):**
```bash
# Windows PowerShell
curl -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  "http://localhost:3000/api/mailboxes/usuario@example.com/emails?page=2&limit=10"

# Linux/Mac
curl -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  "http://localhost:3000/api/mailboxes/usuario@example.com/emails?page=2&limit=10"
```

---

### Envio de E-mails

**9. Enviar E-mail (texto simples):**
```bash
# Windows PowerShell
curl -X POST http://localhost:3000/api/send `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{
    \"from\": \"minhaconta@gmail.com\",
    \"to\": \"destinatario@example.com\",
    \"subject\": \"Teste de Envio\",
    \"text\": \"Este é um e-mail de teste enviado via API.\"
  }'

# Linux/Mac
curl -X POST http://localhost:3000/api/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "minhaconta@gmail.com",
    "to": "destinatario@example.com",
    "subject": "Teste de Envio",
    "text": "Este é um e-mail de teste enviado via API."
  }'
```

**10. Enviar E-mail (HTML com confirmação de leitura):**
```bash
# Windows PowerShell
curl -X POST http://localhost:3000/api/send `
  -H "Authorization: Bearer $TOKEN" `
  -H "Content-Type: application/json" `
  -d '{
    \"from\": \"minhaconta@gmail.com\",
    \"to\": \"destinatario@example.com\",
    \"subject\": \"E-mail com HTML\",
    \"html\": \"<h1>Olá!</h1><p>Este é um <strong>e-mail HTML</strong>.</p>\",
    \"text\": \"Versão em texto plano\",
    \"requestReadReceipt\": true
  }'

# Linux/Mac
curl -X POST http://localhost:3000/api/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "minhaconta@gmail.com",
    "to": "destinatario@example.com",
    "subject": "E-mail com HTML",
    "html": "<h1>Olá!</h1><p>Este é um <strong>e-mail HTML</strong>.</p>",
    "text": "Versão em texto plano",
    "requestReadReceipt": true
  }'
```

---

### Endpoints de Teste

**11. Listar Mailboxes Ativas no Worker:**
```bash
# Windows PowerShell
curl -H "Authorization: Bearer $TOKEN" `
  http://localhost:3000/test/list-mailboxes

# Linux/Mac
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/test/list-mailboxes
```

**12. Forçar Desconexão IMAP:**
```bash
# Windows PowerShell
curl -X POST "http://localhost:3000/test/force-disconnect/1?email=usuario@gmail.com" `
  -H "Authorization: Bearer $TOKEN"

# Linux/Mac
curl -X POST "http://localhost:3000/test/force-disconnect/1?email=usuario@gmail.com" \
  -H "Authorization: Bearer $TOKEN"
```

---

### Exemplos Práticos de Uso

**Fluxo Completo: Adicionar e Testar Mailbox**

```bash
# 1. Adicionar mailbox
curl -X POST http://localhost:3000/api/mailboxes \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "teste@gmail.com",
    "password": "senha_app",
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "imap_secure": true,
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 465,
    "smtp_secure": true
  }'

# 2. Aguardar 60 segundos para sincronização inicial

# 3. Verificar status
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/health/teste@gmail.com

# 4. Listar e-mails sincronizados
curl -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/mailboxes/teste@gmail.com/emails?page=1&limit=5"

# 5. Enviar e-mail de teste
curl -X POST http://localhost:3000/api/send \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "from": "teste@gmail.com",
    "to": "destinatario@example.com",
    "subject": "Teste",
    "text": "Mensagem de teste"
  }'
```

---

### Dicas para Uso com cURL

**1. Salvar resposta em arquivo:**
```bash
curl -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/mailboxes \
  -o mailboxes.json
```

**2. Ver headers da resposta:**
```bash
curl -i -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/health/live
```

**3. Modo verbose (debug):**
```bash
curl -v -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/mailboxes
```

**4. Ignorar certificado SSL (apenas desenvolvimento):**
```bash
curl -k -H "Authorization: Bearer $TOKEN" \
  https://localhost:3000/api/mailboxes
```

**5. Timeout personalizado:**
```bash
curl --max-time 30 -H "Authorization: Bearer $TOKEN" \
  http://localhost:3000/api/mailboxes
```

---

## Exemplo de Collection Postman


### Configuração de Environment

Crie ambiente com variáveis:

```
base_url: http://localhost:3000
api_token: seu_token_aqui
test_email: teste@gmail.com
```

### Requests Sugeridas

1. **Health Live** - `GET {{base_url}}/health/live`
2. **Health Email** - `GET {{base_url}}/health/{{test_email}}`
3. **List Mailboxes** - `GET {{base_url}}/api/mailboxes`
4. **Add Mailbox** - `POST {{base_url}}/api/mailboxes`
5. **List Emails** - `GET {{base_url}}/api/mailboxes/{{test_email}}/emails`
6. **Send Email** - `POST {{base_url}}/api/send`
7. **Delete Mailbox** - `DELETE {{base_url}}/api/mailboxes/{{test_email}}`
8. **Test List** - `GET {{base_url}}/test/list-mailboxes`

### Pre-request Script Global

```javascript
// Adicionar token automaticamente (exceto /health/live)
if (!pm.request.url.getPath().includes('/health/live')) {
  pm.request.headers.add({
    key: 'Authorization',
    value: 'Bearer ' + pm.environment.get('api_token')
  });
}
```

---

## Suporte e Contato

Para problemas ou dúvidas:
- Verificar logs do worker e API
- Consultar esta documentação
- Revisar configuração do `.env`
- Verificar status do Supabase

---

**Versão da Documentação:** 1.1  
**Última Atualização:** 22/11/2025
