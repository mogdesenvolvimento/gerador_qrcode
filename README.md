# Gerador de QR Codes - Inca Bar

Aplicacao Node.js + Express para upload de imagens, geracao de QR Codes individuais com logo opcional e publicacao em producao no dominio `https://qrcode.incabar.com.br`.

## Stack

- Node.js
- Express
- Multer
- QRCode
- Sharp
- Slugify
- FS-Extra
- Archiver

## URLs de producao

- Admin: `https://qrcode.incabar.com.br/admin/qrcodes`
- Mensagem publica: `https://qrcode.incabar.com.br/mensagem/{slug}`
- Healthcheck: `https://qrcode.incabar.com.br/health`

## Variaveis de ambiente

Arquivo `.env`:

```env
BASE_URL=https://qrcode.incabar.com.br
NODE_ENV=production
```

No Railway, defina:

- `BASE_URL=https://qrcode.incabar.com.br`
- `NODE_ENV=production`

O Railway injeta `PORT` automaticamente e a aplicacao escuta em `0.0.0.0:$PORT`.
Se `BASE_URL` ainda nao estiver definida, a aplicacao tenta usar `RAILWAY_PUBLIC_DOMAIN` automaticamente como fallback temporario de deploy.

## Rodando localmente

Instalacao:

```bash
npm install
```

Desenvolvimento:

```bash
npm run dev
```

Producao:

```bash
npm start
```

Se voce quiser links locais em desenvolvimento, ajuste temporariamente a `BASE_URL` no `.env` antes de iniciar a app.

## Estrutura do projeto

```txt
project/
  app.js
  package.json
  railway.json
  README.md
  .env
  .env.example
  /branding
    logo.png
  /data
    uploads.json
    state.json
  /outputs
    /qrcodes
  /public
    admin.css
  /uploads
```

## Rotas

```txt
GET  /admin/qrcodes
POST /admin/upload-images
POST /admin/upload-logo
POST /admin/generate-qrcodes
GET  /admin/download-qrcodes
GET  /mensagem/:slug
GET  /uploads/:filename
GET  /qrcodes/:filename
GET  /health
```

## Fluxo administrativo

1. Acesse `/admin/qrcodes`.
2. Envie varias imagens permitidas: `.png`, `.jpg`, `.jpeg`, `.webp`.
3. Envie um logo opcional para o centro do QR Code.
4. Clique em `Criar QR Codes`.
5. Revise link publico, preview da imagem, preview do QR e status.
6. Baixe `qrcodes-incabar.zip`.

## Comportamentos implementados

- Upload multiplo com limite de 10 MB por imagem
- Slugs amigaveis com remocao de acentos
- Slugs unicos com sufixos incrementais: `slug`, `slug-2`, `slug-3`
- Logo salvo em `/branding/logo.png`
- QR Codes PNG 1000x1000
- Error correction level `H`
- Fundo branco atras do logo para preservar leitura
- QR Codes salvos em `/outputs/qrcodes`
- Download ZIP com nomes amigaveis
- Dashboard com metricas de total de imagens, total de QRs e ultima geracao
- Healthcheck simples em `/health`
- Logs padronizados:
  - `[UPLOAD OK]`
  - `[LOGO OK]`
  - `[QR GENERATED]`
  - `[ZIP READY]`
  - `[ERROR]`

## Deploy no Railway

1. Conecte o repositorio GitHub ao Railway.
2. Garanta que o branch publicado existe no GitHub.
3. Configure `BASE_URL=https://qrcode.incabar.com.br`.
4. Configure `NODE_ENV=production`.
5. O arquivo `railway.json` ja define `npm start` como start command.
6. Gere primeiro um dominio Railway temporario para validar o deploy.
7. Em Settings > Networking, adicione o dominio customizado `qrcode.incabar.com.br`.

## DNS do dominio customizado

Ao adicionar `qrcode.incabar.com.br` no Railway, a plataforma informa os registros necessarios.

Normalmente:

- um `CNAME` apontando para o dominio Railway fornecido
- um `TXT` para validacao de propriedade

Crie os registros exatamente como o Railway pedir no DNS do dominio `incabar.com.br`.

## Notas de producao

- Uploads e QR Codes ficam no filesystem do container.
- Em redeploys ou troca de instancia, esses arquivos podem ser perdidos sem persistencia.
- Para uso duravel, considere volume persistente no Railway ou armazenamento externo.
- A pagina publica retorna 404 amigavel se o slug nao existir ou se o arquivo original nao estiver disponivel.

## Referencias Railway

- Variaveis: [Using Variables](https://docs.railway.com/variables)
- Porta e networking publico: [Public Networking](https://docs.railway.com/public-networking)
- Dominio customizado e DNS: [railway domain](https://docs.railway.com/cli/domain)
