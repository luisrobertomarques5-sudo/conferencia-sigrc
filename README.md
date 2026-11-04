# Conferência SIGRC

Ferramenta de conferência automática das solicitações **Recebidas** e **Atribuídas** do sistema Resolução (SIGRC), com planilha Excel, auditoria e retomada de processos interrompidos.

Ela roda **dentro do próprio Chrome**, como um favorito, usando o login que já está aberto no SIGRC. Não precisa instalar nada.

## Instalação

1. Abra a página de instalação (o `index.html` deste repositório, publicado pelo GitHub Pages).
2. Mostre a barra de favoritos (`Ctrl` + `Shift` + `B`) e arraste o botão laranja **Conferência SIGRC** para ela.
3. Abra o SIGRC, faça login e clique no favorito.

## O que a ferramenta faz

**Recebidas:** lê todas as páginas da caixa, abre cada solicitação pelo número e extrai o detalhe e o formulário.

**Atribuídas:** faz o mesmo e lê **todas as páginas do Histórico**. Em cada registro "Proposta de resposta", guarda a data, o operador, o órgão, o meio e o **texto integral**. Sem proposta, a planilha registra "Sem proposta de resposta no histórico".

**Planilha:** importa uma planilha .xlsx como base e mantém as colunas, a ordem, as colunas próprias da equipe e as outras abas. Unifica linhas repetidas e exporta um Excel com as abas Recebidas, Atribuídas, Resumo, Auditoria e Log.

**Auditoria:** cada solicitação fica marcada como Verificada, Pendente, Incompleta ou Erro, com data e hora. A auditoria também registra as etapas lidas, as tentativas, as duplicidades e as solicitações que saíram da caixa. Uma conferência interrompida (sessão expirada ou página recarregada) pode ser retomada de onde parou.

## Regras de segurança

- **Somente leitura.** A ferramenta só faz consultas (GET). Nunca responde, atribui, transfere ou altera solicitações.
- **Nenhuma senha é pedida ou guardada.** A ferramenta usa a sessão já aberta no SIGRC.
- **Os dados ficam no computador do usuário:** no navegador (IndexedDB, para poder retomar) e no arquivo exportado. Nada é enviado a terceiros.
- **Dados pessoais de identificação ficam de fora por padrão** (CPF, e-mail, telefone, Cartão SUS etc.), pela LGPD. Eles podem ser ativados em Configurações.
- **Só conta como Verificada** a solicitação cujo detalhe e formulário foram lidos. Nas Atribuídas, todas as páginas do histórico também precisam ter sido lidas e o total precisa bater com o que o sistema informa.
- **Nada é inventado:** campos que o sistema não informa ficam vazios.

## Estrutura

| Caminho | Conteúdo |
|---|---|
| `index.html` | Página de instalação com o favorito pronto (gerada). |
| `src/conferencia-sigrc.js` | Código-fonte do painel (sem dependências). |
| `dist/conferencia-sigrc.min.js` | Versão minificada (gerada). |
| `build/` | Script de build e modelo da página de instalação. |
| `planilhas/` | Modelo de planilha vazio e um exemplo com dados fictícios. |
| `test/` | SIGRC simulado com dados fictícios e testes de ponta a ponta (Playwright). |

## Desenvolvimento

```bash
node build/build.js                 # gera dist/ e index.html
node test/mock-server.js &          # SIGRC simulado em http://127.0.0.1:8765
node test/e2e.js                    # conferência completa, sessão expirada, retomada, importação/exportação
```

Depois de alterar o código, rode o build e reinstale o favorito a partir do novo `index.html`.
