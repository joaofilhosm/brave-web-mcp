# Brave Web MCP

Servidor **Model Context Protocol** com busca em tempo real na internet e leitura de paginas.

- **Brave Search API** como motor principal
- **DuckDuckGo** como fallback automatico quando a Brave falha (sem key, cota esgotada ou erro upstream)
- Extracao do conteudo principal das paginas em Markdown
- Feito para rodar em **serverless na Vercel**
- Compativel com **Claude**, **OpenAI**, **Cursor** e qualquer cliente MCP

## Tools

| Tool | O que faz |
|------|-----------|
| `web_search` | Busca na web, noticias, imagens e videos. Filtros de idioma, pais e recencia. |
| `web_fetch` | Le uma URL e devolve o conteudo principal em Markdown (sem script, nav, rodape). |
| `web_context` | Busca e extrai excertos das paginas, grounding com fonte em uma chamada. |
| `search_and_read` | Busca e le os melhores resultados de uma vez. |

Todas as tools seguem o padrao MCP: `inputSchema` + `outputSchema`, com `structuredContent` no retorno.

## Deploy na Vercel

```bash
npm install -g vercel
vercel            # preview
vercel --prod     # producao
```

Depois de conectar o projeto, cadastre a variavel de ambiente:

```bash
vercel env add BRAVE_API_KEY production
```

Obtenha a key em <https://api-dashboard.search.brave.com/>.

Sem a key o servidor continua funcionando: a busca cai para o DuckDuckGo automaticamente.

O endpoint MCP fica em `https://SEU-DOMINIO.vercel.app/mcp`.

## Conectar em um cliente MCP

### Claude Desktop / Claude Code

```json
{
  "mcpServers": {
    "brave-web": {
      "type": "http",
      "url": "https://SEU-DOMINIO.vercel.app/mcp"
    }
  }
}
```

### Cursor

Abra **Settings > MCP Servers** e adicione:

```json
{
  "mcpServers": {
    "brave-web": {
      "url": "https://SEU-DOMINIO.vercel.app/mcp"
    }
  }
}
```

### OpenAI (Responses API / Agents SDK)

O transporte MCP usa JSON-RPC 2.0 sobre HTTP POST, entao pode ser exposto como uma tool
OpenAI usando o schema de `tools/list` e `tools/call`:

```json
{
  "type": "function",
  "function": {
    "name": "web_search",
    "description": "Search the live web and return results with title, url and description.",
    "parameters": {
      "type": "object",
      "properties": {
        "query": { "type": "string", "description": "Search keywords" },
        "count": { "type": "integer", "description": "Number of results, 1-20" },
        "type": { "type": "string", "enum": ["web", "news", "images", "videos"] }
      },
      "required": ["query"]
    }
  }
}
```

### Clientes sem suporte a URL direta

Use a ponte `mcp-remote`:

```json
{
  "mcpServers": {
    "brave-web": {
      "command": "npx",
      "args": ["mcp-remote@next", "https://SEU-DOMINIO.vercel.app/mcp"]
    }
  }
}
```

## Variaveis de ambiente

| Variavel | Obrigatoria | Padrao | Descricao |
|----------|-------------|--------|-----------|
| `BRAVE_API_KEY` | nao | - | Chave da Brave Search API. Sem ela, usa apenas o DuckDuckGo. |
| `BRAVE_SEARCH_LANG` | nao | `pt-br` | Locale padrao das buscas |
| `BRAVE_SEARCH_COUNTRY` | nao | `BR` | Pais padrao das buscas |
| `FETCH_ALLOW_PRIVATE_HOSTS` | nao | - | Hosts privados liberados explicitamente |

## Notas de implementacao

- **Stateless**: cada requisicao cria um servidor MCP novo, com `sessionIdGenerator: undefined`.
  Serverless nao garante reaproveitamento de instancias, entao sessoes nao sao mantidas.
- **Transporte**: Streamable HTTP. `GET`/`DELETE` em `/mcp` respondem 405, conforme a spec.
- **Fallback em cascata**: Brave primeiro; se falhar ou nao houver key, o DuckDuckGo assume.
  A resposta inclui o campo `engine` com o motor que respondeu.
- **SSRF**: `web_fetch` valida cada salto de redirect contra redes privadas, loopback e o
  endereco link-local de metadados do cloud, e resolve o DNS novamente no momento da
  conexao para bloquear DNS rebinding.
- **Brave quirks**: a API rejeita o header `Accept: application/json` (422) e `search_lang` usa
  valores como `pt-br`, `pt-pt`, `en-gb` — `pt` puro e invalido. Os endpoints de news e
  images devolvem `results` na raiz, sem bucket.

## Estrutura

```
api/mcp.ts           # entrypoint serverless (Vercel)
src/brave.ts         # cliente da Brave Search API
src/duckduckgo.ts    # fallback via scraping do endpoint HTML
src/search.ts        # motor unificado com fallback Brave -> DDG
src/fetcher.ts       # fetch + extracao Markdown + protecao SSRF
src/server.ts        # definicao das tools MCP
test/e2e.ts          # teste end-to-end com cliente MCP real
test/fallback.ts     # teste do fallback DuckDuckGo
```

## Testes

```bash
# com Brave
BRAVE_API_KEY=sua-key npx tsx test/e2e.ts

# fallback DuckDuckGo (key invalida de proposito)
BRAVE_API_KEY=invalid npx tsx test/fallback.ts
```

## Licenca

MIT. O motor de fetch, a protecao SSRF e o parser do DuckDuckGo foram adaptados de
[sunwu51/orz-mcp](https://github.com/sunwu51/orz-mcp) (MIT).
