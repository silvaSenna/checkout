# Validação da entrega

Validação local em 29/09/2026, Node.js 22.22.3. Os resultados abaixo descrevem o ambiente realmente utilizado; não representam uma homologação no ambiente do provedor.

| Verificação                              | Resultado                                              |
| ---------------------------------------- | ------------------------------------------------------ |
| TypeScript estrito                       | Aprovado                                               |
| ESLint                                   | Aprovado                                               |
| Prettier                                 | Aprovado                                               |
| Build para execução Node.js              | Aprovado                                               |
| Testes unitários e de contrato           | 84 aprovados                                           |
| Integração com PostgreSQL real e HTTP    | 15 aprovados                                           |
| Inicialização dos entrypoints compilados | Migration, API e worker aprovados                      |
| Smoke test do processo HTTP              | Criação PIX: `201`, `PENDING`, valor `0.29` preservado |
| Encerramento por SIGTERM                 | API e worker encerraram no prazo do teste              |
| Auditoria de dependências de produção    | Zero vulnerabilidades reportadas pelo npm audit        |

Os testes de integração utilizaram PostgreSQL 18.4 temporário, com schemas isolados. O Compose/CI fornecido usa PostgreSQL 17; essa versão e o build da imagem Docker não foram executados localmente: o socket Docker não está acessível ao usuário e o plugin Compose não está instalado. A configuração de CI inclui teste com PostgreSQL 17 e build da imagem, mas nenhum resultado remoto de CI é alegado nesta entrega.

A medição unitária mostra 100% das linhas do domínio cobertas. O relatório é limitado aos módulos carregados pela suíte; **não é cobertura global de toda a aplicação**. Controllers, repositórios, filas e migrations têm validação na suíte de integração separada. Execute `npm run test:coverage` para o relatório atual.

## Cenários verificados

- CPF válido/ inválido, máscaras, dígitos verificadores e CPFs repetidos.
- Dinheiro sem fração de centavo, sem arredondamento e com limites de valor.
- Idempotência com normalização e conflito de payload.
- Doze criações concorrentes com mesma chave produzem uma cobrança, um evento e um job.
- Falha ao gravar outbox reverte cobrança, evento e chave na mesma transação.
- Atualizações concorrentes com mesma versão aceitam um único vencedor.
- Workers não disputam o mesmo job; lease expirada permite recuperação; posse antiga não conclui o job retomado.
- Backoff, limite de tentativas, dead letter e revisão técnica sem falsa rejeição financeira.
- Preferência remota é reaproveitada diante de conflito local de versão.
- Callbacks adulterados, expirados ou com IDs divergentes são rejeitados.
- Corpo de callback não decide status; o worker consulta o gateway.
- Notificação só recebe confirmação depois de persistir a inbox.
- Divergência financeira preserva `PENDING` e gera revisão operacional.
- Cartão não aceita liquidação manual pela API.
- Duplicatas, eventos antigos e uma segunda aprovação não substituem indevidamente uma liquidação.
- Status fora do escopo vão para revisão.
- HTTP real: autenticação, entradas inválidas, tamanho de payload, ETags, filtros, paginação, health e OpenAPI.

## Limites da verificação

As respostas do Mercado Pago foram controladas nos testes do adapter e do fluxo integrado. Nenhuma credencial real foi fornecida e nenhuma cobrança real foi criada. A validação do Checkout Pro no ambiente externo, da entrega de webhooks por HTTPS e das restrições de tipos de pagamento permanece uma etapa de homologação com as credenciais do responsável.

A execução de PostgreSQL local exigiu permissão para abrir portas temporárias; não foi usado um banco financeiro existente. O runner termina com código diferente de zero se o banco ou os testes falharem.
