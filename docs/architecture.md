# Decisões arquiteturais

## 1. Separar negócio, transporte e persistência

Domínio e aplicação são TypeScript puro. NestJS participa apenas da borda HTTP e da montagem de dependências; PostgreSQL e Mercado Pago implementam portas da aplicação. Não se criou uma abstração genérica de CRUD: as portas expressam operações necessárias para os casos de uso e suas garantias.

SQL explícito torna visíveis transações, índices, compare-and-swap e `SKIP LOCKED`. As migrations são transacionais, serializadas por advisory lock e possuem checksum: alterar uma migration já aplicada provoca erro. Alterações futuras devem ser novas migrations.

## 2. Valor é inteiro, status de integração é separado

`amount_cents` usa `integer`, limitado a 99.999.999 centavos. Conversão usa as partes decimal e inteira da entrada, não multiplicação de ponto flutuante. A única conversão para número decimal ocorre na fronteira JSON exigida pelo Mercado Pago.

O status financeiro tem exatamente os três valores solicitados: `PENDING`, `PAID`, `FAIL`. `checkoutStatus` representa a preparação do checkout. Timeout ou credencial inválida não comprova recusa do pagamento, portanto não muda automaticamente o status para `FAIL`.

CPF é normalizado, validado matematicamente e persistido sem máscara. Não há confirmação de titularidade ou existência cadastral.

## 3. Outbox/inbox em PostgreSQL, sem Temporal

A criação da cobrança e o job de preferência devem ocorrer atomicamente. A notificação deve ser confirmada rapidamente, mas somente depois de persistir a intenção de processamento. Uma tabela de jobs cobre ambas as necessidades.

A posse do job possui lease de 60 segundos e token aleatório. Renovar a posse após uma queda invalida a confirmação do worker anterior. Os jobs normalmente executam até duas chamadas de rede com timeout máximo de 15 segundos por chamada. Uma instância processa um job por vez; outras réplicas aumentam o paralelismo usando `SKIP LOCKED`.

Backoff: `min(300, 2^attempt) + jitter(0..2)` segundos; até oito tentativas. Quedas repetidas também consomem tentativas, pois o contador aumenta no claim. Erros não classificados recebem tentativas limitadas, em vez de desaparecer. `DEAD` exige inspeção/reprocessamento explícito.

Temporal passa a ser uma alternativa interessante se forem necessários espera durável por dias, polling periódico, timers de expiração, compensações e workflows mais longos. A fila atual não tenta reproduzir todas essas capacidades.

## 4. Idempotência local e limites remotos

A chave de criação é global ao serviço interno. CPF sem máscara, descrição aparada, centavos e método compõem o fingerprint. Duas chamadas com a mesma chave são serializadas por advisory lock; a restrição única é uma defesa adicional. A repetição retorna o estado atual do mesmo pagamento, não uma cópia histórica da resposta HTTP.

As chaves são mantidas indefinidamente para impedir reutilização acidental. Uma política de retenção futura deve definir o prazo de garantia antes de remover chaves.

Para webhooks, a deduplicação usa o ID de entrega assinado e o ID do pagamento remoto. Entregas diferentes do mesmo evento podem gerar jobs distintos; a reconciliação idempotente torna isso seguro. O timestamp remoto evita regressão do mesmo pagamento e o estado `PAID` é preservado diante de eventos posteriores não aprovados.

Existe uma janela inevitável entre o POST remoto de preferência e o commit local. Sem uma garantia documentada de idempotência da Preferences API, não se deve afirmar exactly-once. Repetir a operação pode criar preferências extras. Uma preferência não movimenta dinheiro por si só, mas o checkout não equivale a uma autorização única de cobrança. Aprovações adicionais são tratadas como exceção operacional; o serviço não estorna dinheiro automaticamente.

Conflitos locais de versão ao anexar uma preferência reaproveitam a resposta já obtida, até cinco tentativas, sem repetir o POST remoto naquele processamento.

## 5. Callback é um sinal, não a verdade financeira

HMAC autentica o identificador recebido. A decisão financeira usa a leitura autenticada de `/v1/payments/{id}`. ID, vendedor (`collector_id`), ambiente (`live_mode`), referência UUID, valor, BRL e `credit_card` devem corresponder ao registro local.

Rejeição e aprovação podem pertencer a tentativas distintas na mesma preferência. Por isso, `FAIL → PAID` é permitido exclusivamente pela reconciliação de cartão. Uma aprovação já aplicada não é substituída por outra; `DUPLICATE_APPROVAL` exige revisão.

A entidade guarda a última transação conciliada, e eventos de cada alteração são preservados. Não é um livro-razão completo de todas as tentativas do provedor. Uma evolução de conciliação contábil deve modelar tentativas, recebíveis, estornos e chargebacks como entidades próprias.

`refunded` e `charged_back` não cabem nos três estados definidos no enunciado. Convertê-los silenciosamente para `FAIL` destruiria a distinção entre uma cobrança nunca paga e uma cobrança estornada. São exceções operacionais nesta versão.

A janela HMAC padrão é de cinco minutos; o código aceita segundos e milissegundos porque a documentação apresenta ambos os formatos. Monitore relógios sincronizados e confirme a assinatura usada nas reentregas do ambiente real. Se o provedor reutilizar timestamps antigos, o fluxo operacional deve reconciliar a entrega rejeitada; aumentar a tolerância não substitui essa análise.

## 6. Restrição de tipo no Checkout Pro

A documentação informa que saldo em conta não pode ser excluído. A integração descobre os tipos via `/v1/payment_methods`, exclui os tipos configuráveis diferentes de cartão e preserva a verificação do tipo efetivamente pago na reconciliação.

Uma transação paga com saldo permanece sem liquidação automática local e vai para `DEAD` com divergência. Esse limite do produto externo está explícito para não anunciar uma garantia que a Preferences API não oferece. Exigir exclusivamente cartão, sem essa possibilidade, demandaria reavaliar o produto de checkout com o solicitante.

## 7. Atualização e autenticação

O endpoint `PUT` aplica campos presentes, acompanhando a convenção de atualização do teste. O contrato documenta a semântica parcial; uma API nova sem essa restrição preferiria `PATCH` para essa operação.

PIX permite alteração de descrição enquanto pendente e transição de `PENDING` para `PAID` ou `FAIL`. Estados finais de PIX não reabrem. Valor, CPF e método permanecem imutáveis. Cartão não aceita status manual nem edição de dados enviados ao checkout. `If-Match` impede perda silenciosa de atualização.

A API key é uma proteção serviço-a-serviço simples, acima do mínimo do enunciado. Não implementa usuários, RBAC nem multi-tenancy. Não deve ser entregue a um navegador público como credencial de todos os clientes. Idempotência por tenant e autorização por recurso seriam necessárias nesse cenário.

## Referências verificadas

- [Criação e configuração de preferência](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/create-payment-preference)
- [Autenticação e processamento de notificações](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/payment-notifications)
- [Consulta de pagamento](https://www.mercadopago.com.br/developers/pt/reference/online-payments/checkout-pro-preferences/get-payment/get)
- [Exclusão de meios de pagamento e restrição de saldo em conta](https://www.mercadopago.com.br/developers/pt/docs/checkout-pro-preferences/additional-settings/payment-methods)

Consulta em 29/09/2026. O adapter usa HTTP nativo, com validação de resposta, timeout e host fixo. Não recebe URL externa de uma notificação nem segue redirects com o token.
