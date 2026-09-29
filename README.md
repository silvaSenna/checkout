# Payments API

API REST para gerenciar cobranças PIX e cartão de crédito com Mercado Pago Checkout Pro (Preferences API). Implementação do teste técnico em **Node.js 22, TypeScript estrito, NestJS 12 e PostgreSQL**, organizada em Clean Architecture.

PIX é registrado como `PENDING`, sem chamada externa. Cartão é registrado junto com um job transacional; o worker cria a preferência e publica a URL de checkout no pagamento. O webhook autentica a notificação, persiste o recebimento e agenda uma consulta ao Mercado Pago antes de alterar o status.

## Execução rápida

Requisitos: Docker Engine e Docker Compose v2. Para desenvolvimento fora do container: Node.js 22.16+ e npm 10+.

```bash
cp .env.example .env
# Edite .env; substitua API_KEY por uma chave aleatória de pelo menos 32 caracteres.
docker compose up --build -d
```

O Compose inicia PostgreSQL, aplica migrations e sobe a API. Por padrão, é possível executar todo o fluxo PIX sem credenciais externas. O Compose é uma configuração de desenvolvimento, com portas vinculadas a `127.0.0.1`.

- Swagger: [localhost:3000/docs](http://localhost:3000/docs)
- OpenAPI: [localhost:3000/openapi.json](http://localhost:3000/openapi.json)
- Readiness: [localhost:3000/health/ready](http://localhost:3000/health/ready)

Para cartão, configure as cinco variáveis comentadas `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `MP_COLLECTOR_ID`, `MP_WEBHOOK_URL` e `MP_RETURN_URL` no `.env` e inicie também o worker:

```bash
docker compose --profile card up --build -d
```

`MP_COLLECTOR_ID` é o identificador do vendedor da credencial utilizada. `MP_WEBHOOK_URL` deve ser uma URL HTTPS pública que alcance `/api/webhooks/mercado-pago`. `MP_RETURN_URL` aponta para a página de resultado do seu frontend; retornar a essa página **não comprova pagamento**. Configure o tópico `payment` e a chave de assinatura no painel do Mercado Pago. Use vendedor e comprador de teste distintos; mantenha `MP_SANDBOX=true` para selecionar `sandbox_init_point` e recusar transações de produção.

Nenhuma credencial ou transação real é incluída. A validação de ponta a ponta no ambiente do Mercado Pago depende dessas credenciais e do endpoint HTTPS acessível.

### Desenvolvimento local

```bash
npm ci
cp .env.example .env
# Configure .env antes de continuar.
docker compose up db -d
npm run db:migrate
npm run build
npm start
# Em outro terminal, após configurar Mercado Pago:
npm run worker
```

O comando `dev` compila e inicia a API, sem hot reload. Banco, API e worker são processos independentes. Reiniciar a API não apaga pagamentos ou jobs. Não execute `docker compose down -v` se quiser preservar os dados.

## Contrato HTTP

Todas as rotas de pagamentos exigem `x-api-key`. Webhooks usam HMAC, e health/documentação são públicos. A chave representa **um único serviço interno autorizado**; não há identidade de cliente nem isolamento multi-tenant.

| Método | Rota                         | Comportamento                                                             |
| ------ | ---------------------------- | ------------------------------------------------------------------------- |
| POST   | `/api/payment`               | Cria cobrança; exige `Idempotency-Key`                                    |
| PUT    | `/api/payment/{id}`          | Atualiza campos permitidos; exige `If-Match`                              |
| GET    | `/api/payment/{id}`          | Retorna cobrança e `ETag`                                                 |
| GET    | `/api/payment`               | Filtra por `cpf`, `paymentMethod`, `status`; pagina com `limit` e `after` |
| POST   | `/api/webhooks/mercado-pago` | Recebe notificação assinada de pagamento                                  |
| GET    | `/health/live`               | Verifica processo HTTP                                                    |
| GET    | `/health/ready`              | Verifica acesso ao banco e presença da tabela de migrations               |

### Criar PIX

Defina `PAYMENTS_API_KEY` com o mesmo valor de `API_KEY` do `.env`:

```bash
export PAYMENTS_API_KEY='sua-chave-configurada-no-env-com-32-caracteres'

curl -i http://localhost:3000/api/payment \
  -H "x-api-key: $PAYMENTS_API_KEY" \
  -H 'Idempotency-Key: pedido-exemplo-0001' \
  -H 'Content-Type: application/json' \
  -d '{"cpf":"52998224725","description":"Assinatura mensal","amount":"150.90","paymentMethod":"PIX"}'
```

Resposta `201 Created`, com `Location`, `ETag: "1"` e corpo:

```json
{
  "id": "fddcf589-938b-43d9-9202-e45e75748586",
  "cpf": "52998224725",
  "description": "Assinatura mensal",
  "paymentMethod": "PIX",
  "status": "PENDING",
  "checkoutStatus": "NOT_REQUIRED",
  "preferenceId": null,
  "checkoutUrl": null,
  "providerPaymentId": null,
  "providerUpdatedAt": null,
  "version": 1,
  "createdAt": "2026-09-29T12:00:00.000Z",
  "updatedAt": "2026-09-29T12:00:00.000Z",
  "amount": "150.90",
  "currency": "BRL"
}
```

O identificador e as datas acima são ilustrativos. `amount` aceita string decimal ou número JSON; prefira string para evitar cálculos de ponto flutuante no cliente. A resposta sempre utiliza string com duas casas. Limites: `0.01` a `999999.99` BRL, sem arredondamento silencioso. CPF aceita 11 dígitos ou máscara padrão e valida ambos os dígitos verificadores; essa validação não consulta a Receita Federal.

Repetir uma chave de 8–128 caracteres (`A-Z`, `a-z`, números, `_`, `-`) com os mesmos dados normalizados retorna `200`, `Idempotency-Replayed: true` e **o estado atual** do mesmo recurso. Dados diferentes com a mesma chave retornam `409`. As chaves não expiram automaticamente nesta implementação.

### Atualizar e listar

```bash
export PAYMENT_ID='uuid-retornado-na-criacao'

curl -i "http://localhost:3000/api/payment/$PAYMENT_ID" \
  -H "x-api-key: $PAYMENTS_API_KEY"

curl -i -X PUT "http://localhost:3000/api/payment/$PAYMENT_ID" \
  -H "x-api-key: $PAYMENTS_API_KEY" \
  -H 'If-Match: "1"' \
  -H 'Content-Type: application/json' \
  -d '{"status":"PAID"}'

curl 'http://localhost:3000/api/payment?cpf=52998224725&paymentMethod=PIX&limit=20' \
  -H "x-api-key: $PAYMENTS_API_KEY"
```

Use o `ETag` mais recente no `If-Match`. Sem header: `428`; versão obsoleta: `412`. O `PUT` aplica os campos enviados, conforme a operação de atualização pedida no enunciado. Descrição é editável apenas para PIX pendente. CPF, valor e meio são imutáveis. A API recusa alteração manual de status de cartão; isso impediria distinguir liquidação real de uma afirmação do cliente.

A listagem retorna `{ "data": [...], "nextCursor": "uuid-ou-null" }`. Passe `nextCursor` em `after`, mantendo os filtros. `limit` vai de 1 a 100. A ordem é por UUID, não cronológica; o cursor oferece navegação estável para registros existentes, sem promessa de snapshot diante de novas inserções.

### Cartão e callback

Crie com `paymentMethod: "CREDIT_CARD"` e uma nova chave. A resposta é `201`: **a cobrança já existe**, enquanto `checkoutStatus: "PROCESSING"` indica a criação assíncrona da preferência. Consulte o `Location` até obter `READY` e `checkoutUrl`. `REQUIRES_REVIEW` indica que o processamento esgotou tentativas ou encontrou falha permanente. Falha técnica não é tratada como rejeição financeira.

O callback usa `POST /api/webhooks/mercado-pago?data.id=123&type=payment`, headers `x-signature` e `x-request-id`, e corpo `{ "type": "payment", "data": { "id": "123" } }`. Campos extras do payload do provedor são tolerados. O corpo não pode trocar o ID assinado da query. O `200` só é enviado depois da persistência na inbox.

A assinatura usa HMAC-SHA256, comparação em tempo constante e janela configurável de cinco minutos, aceitando timestamps em segundos ou milissegundos. Depois, o worker consulta `GET /v1/payments/{id}` com a credencial do servidor e verifica ID, vendedor, ambiente, referência, valor, moeda e tipo de pagamento.

| Status do provedor                                    | Estado local                                 |
| ----------------------------------------------------- | -------------------------------------------- |
| `approved`                                            | `PAID`                                       |
| `rejected`, `cancelled`                               | `FAIL`                                       |
| `pending`, `in_process`, `authorized`, `in_mediation` | `PENDING`                                    |
| Desconhecido, `refunded`, `charged_back`              | Job em revisão; estado financeiro preservado |

Aprovação não regride por notificação tardia. Uma nova tentativa aprovada pode liquidar uma cobrança cuja tentativa anterior falhou. Uma segunda transação aprovada para uma cobrança já paga gera `DUPLICATE_APPROVAL`, sem substituir a primeira transação.

**Limite do Checkout Pro:** o provedor não permite excluir saldo em conta. A integração consulta os tipos disponíveis e exclui os tipos configuráveis diferentes de cartão; recebimentos com saldo são encaminhados para revisão, sem aprovar automaticamente a cobrança de cartão. Isso precisa ser validado como requisito de produto antes de uso comercial. Veja [decisões arquiteturais](docs/architecture.md).

## Arquitetura e garantias

```text
src/domain           Entidade, validação de CPF/dinheiro e transições; sem Nest/SQL
src/application      Casos de uso e portas; depende apenas do domínio
src/infrastructure   PostgreSQL, filas, migrations, cliente Mercado Pago, HMAC
src/http             Controllers Nest, autenticação, schemas, erros e Swagger
src/composition.ts   Montagem explícita dos adapters
src/main.ts          Processo HTTP
src/worker.ts        Processo de jobs
```

- Pagamento, idempotência, evento inicial e outbox são gravados em **uma transação**.
- Chaves concorrentes são serializadas no PostgreSQL, inclusive entre réplicas.
- Atualizações usam controle otimista de versão e auditoria na mesma transação.
- Workers usam `FOR UPDATE SKIP LOCKED`, lease de 60 segundos e token de posse.
- Falhas transitórias usam backoff exponencial com jitter; falhas permanentes e esgotamento de oito tentativas vão para `DEAD`.
- Dados monetários usam inteiros; entradas estritas recusam mass assignment; SQL usa parâmetros.
- Logs não incluem CPF, corpo, query string, credenciais ou respostas brutas do provedor.

Não há promessa de exactly-once no Mercado Pago. Uma queda após criar a preferência remota e antes de persistir seu identificador pode gerar outra preferência ao repetir o job. `external_reference` preserva a correlação; a criação de preferência não debita um cartão. O projeto não presume suporte a idempotência remota da Preferences API. Há detalhes e consequências em [architecture.md](docs/architecture.md).

Temporal é opcional no enunciado. A outbox/inbox PostgreSQL cobre o processamento durável deste escopo sem outro serviço. Não há polling automático de pagamentos que nunca notificaram; a recuperação operacional está descrita no [runbook](docs/operations.md).

## Qualidade e testes

```bash
npm run check              # TypeScript + ESLint + Prettier + testes unitários + build
npm run test:coverage      # Cobertura dos módulos carregados na suíte unitária
npm run test:integration   # PostgreSQL real isolado + HTTP, sem credenciais Mercado Pago
npm audit --omit=dev
```

Sem `TEST_DATABASE_URL`, o teste de integração inicia PostgreSQL temporário via `embedded-postgres`, em porta local livre, e remove o cluster ao terminar. Requer usuário não-root e permissão para abrir portas locais. Com PostgreSQL existente, inclusive Docker/CI:

```bash
TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/payments_test npm run test:integration
```

Os testes criam e removem apenas um schema exclusivo, com UUID, dentro desse banco. Use um banco dedicado a testes. Eles não ignoram silenciosamente a ausência de banco nem dependem de emulação SQL em memória.

A suíte cobre validação, regras de status, idempotência, autenticação, HMAC, contrato HTTP do adapter, transações, rollback, concorrência, leases e fluxo completo com o gateway controlado. As chamadas externas são simuladas; a execução local não equivale à homologação no Mercado Pago. O CI também constrói a imagem Docker.

Veja [validação realizada](docs/validation.md), [decisões](docs/architecture.md), [operação](docs/operations.md) e [requisições de exemplo](docs/requests.http).
