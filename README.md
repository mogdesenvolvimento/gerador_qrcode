# Gerador de QR Codes - Inca Bar

MVP em Node.js + Express para enviar imagens, gerar QR Codes individuais com ou sem logo central e baixar tudo em ZIP.

## Requisitos

- Node.js 20+ recomendado
- npm

## Instalação

```bash
npm install
```

## Configuração

Crie um arquivo `.env` na raiz:

```env
BASE_URL=https://incabar.com.br
PORT=3000
```

Durante desenvolvimento, você pode usar:

```env
BASE_URL=http://localhost:3000
PORT=3000
```

## Rodando o projeto

Desenvolvimento:

```bash
npm run dev
```

Produção:

```bash
npm start
```

Painel administrativo:

```txt
http://localhost:3000/admin/qrcodes
```

## Fluxo do administrador

1. Enviar várias imagens no painel.
2. Enviar um logo opcional para o centro dos QR Codes.
3. Clicar em `Criar QR Codes`.
4. Conferir a listagem com links e previews.
5. Baixar o arquivo `qrcodes-incabar.zip`.

## Estrutura

```txt
project/
  app.js
  package.json
  README.md
  .env.example
  /data
    uploads.json
  /uploads
  /qrcodes
  /public
    /logo
    admin.css
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
```

## Observações de produção

- Defina `BASE_URL` com o domínio final, por exemplo `https://incabar.com.br`.
- Garanta que o proxy ou hospedagem encaminhe o domínio para esta aplicação Node.js.
- As URLs dos QR Codes sempre usam `BASE_URL`, então a variável precisa apontar para o domínio público correto.
- O diretório `uploads/` guarda as imagens originais e deve ser persistido em produção.
- O diretório `qrcodes/` pode ser recriado a qualquer momento pelo botão `Criar QR Codes`.
- O logo é salvo em `public/logo/current-logo.png` e substituído a cada novo envio.

## Bibliotecas usadas

- Express
- Multer
- QRCode
- Sharp
- Slugify
- FS-Extra
- Archiver
- Dotenv

## Comportamentos implementados

- Upload múltiplo com limite de 10 MB por imagem
- Tipos aceitos: `.png`, `.jpg`, `.jpeg`, `.webp`
- Slug amigável com remoção de acentos e caracteres especiais
- Slugs únicos mesmo com nomes repetidos
- QR Code em PNG com `errorCorrectionLevel: "H"`
- Logo central opcional com composição segura para leitura
- Página pública responsiva por slug
- ZIP com todos os QR Codes gerados
