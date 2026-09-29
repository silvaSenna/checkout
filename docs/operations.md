# Operação e recuperação

## Processos e configuração

A API HTTP e o worker são processos separados. Execute migrations antes de iniciar qualquer um deles. O worker requer todas as credenciais Mercado Pago; sem essas variáveis, a API aceita PIX e responde `503 CARD_NOT_CONFIGURED` para cartão.

Em produção, configure `NODE_ENV=production`, chave aleatória, secrets externos ao repositório, PostgreSQL com TLS conforme seu provedor e um proxy HTTPS com limitação de taxa. O Compose entregue é apenas para desenvolvimento. Restrinja a documentação pública se o seu ambiente exigir.

O shutdown aguarda encerramento HTTP e fecha o pool. O worker termina o job em andamento antes de fechar o banco. Em término abrupto, outro worker retoma o job depois de 60 segundos. O grace period do Compose é 45 segundos; uma operação além desse período pode ser retomada por lease.

Logs estruturados incluem ID de requisição/job, duração, status HTTP e código de falha. Não registram CPF, payload, token ou mensagem bruta do provedor. Eventos financeiros ficam na tabela `payment_events`; o caminho de escrita da aplicação é append-only.

## Inspecionar a fila

Execute via cliente PostgreSQL administrativo autorizado:

```sql
SELECT status, kind, count(*) FROM jobs GROUP BY status, kind;

SELECT id, kind, attempts, last_error_code, created_at, updated_at
FROM jobs WHERE status = 'DEAD' ORDER BY updated_at;

SELECT count(*), min(created_at) AS oldest_job
FROM jobs WHERE status IN ('READY', 'RUNNING');

SELECT id, status, checkout_status, created_at
FROM payments
WHERE payment_method = 'CREDIT_CARD' AND status = 'PENDING'
ORDER BY created_at;
```

Alertas recomendados para uma implantação: jobs `DEAD`, aumento de idade da fila, worker sem consumo, excesso de erros 5xx/401 de webhook e cobranças pendentes além da janela de negócio. `/health/ready` verifica o banco da API, não a saúde do worker ou do Mercado Pago.

## Reprocessar um job

1. Consulte `last_error_code` e investigue a causa. Valide a transação no Mercado Pago com acesso autorizado.
2. Corrija credencial/configuração ou a indisponibilidade. Divergência de valor/tipo/vendedor não deve ser resolvida simplesmente removendo validações.
3. Para um job `DEAD`, execute:

```bash
npm run build
npm run jobs:retry -- UUID_DO_JOB
```

O comando usa `DATABASE_URL` do `.env`, altera somente esse job `DEAD` para `READY` e zera o contador de tentativas. O worker deve estar ativo. Jobs concluídos/em execução não são alterados. O checkout continua sinalizado para revisão até a criação bem-sucedida da preferência.

Para `CREATE_PREFERENCE`, confira a possibilidade de a chamada remota anterior já ter criado uma preferência. O sistema não promete ausência de preferências duplicadas após uma resposta perdida. Para `DUPLICATE_APPROVAL`, o estorno ou conciliação é uma decisão financeira externa ao escopo da API.

## Notificação perdida ou rejeitada

A inbox resolve quedas **depois** que o callback chegou ao serviço. O projeto não implementa polling automático de todos os pendentes. Verifique o histórico no painel do Mercado Pago e reenvie a notificação com assinatura válida.

Se for necessária conciliação manual de uma transação conhecida, um operador com acesso ao banco pode criar um job de consulta, sem afirmar nenhum status financeiro:

```sql
-- Substitua os dois valores explicitamente; gen_random_uuid é nativo nas versões suportadas.
INSERT INTO jobs (id, kind, dedup_key, payload)
VALUES (
  gen_random_uuid(),
  'SYNC_PAYMENT',
  'manual:identificador-unico-da-investigacao',
  '{"providerPaymentId":"ID_REAL_DO_MERCADO_PAGO"}'::jsonb
);
```

Esse job ainda consulta o provedor e aplica todas as verificações normais. Registre a intervenção no sistema operacional de auditoria da equipe. Não altere `payments.status` diretamente.

## Retenção e segurança

O código não faz exclusão automática de pagamentos, chaves, jobs concluídos ou eventos. Defina retenção com o responsável pelo produto e política de dados antes da operação contínua. Arquivar/remover chaves ou jobs afeta as janelas de deduplicação. CPF é dado pessoal: mantenha acesso restrito, criptografia em repouso no banco/backups e credenciais com privilégio mínimo conforme o ambiente.

Não há fluxo de estorno, expiração de preferência, chargeback, reconciliação contábil ou autorização de usuários finais. Esses são limites de escopo documentados, não funcionalidades simuladas.
