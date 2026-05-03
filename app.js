const path = require("path");
const fs = require("fs-extra");
const express = require("express");
const multer = require("multer");
const QRCode = require("qrcode");
const sharp = require("sharp");
const slugify = require("slugify");
const archiver = require("archiver");
const dotenv = require("dotenv");

dotenv.config();

const app = express();

const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, "");
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp"
]);
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const ROOT_DIR = __dirname;
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const QRCODES_DIR = path.join(ROOT_DIR, "qrcodes");
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const LOGO_DIR = path.join(PUBLIC_DIR, "logo");
const DATA_DIR = path.join(ROOT_DIR, "data");
const MANIFEST_PATH = path.join(DATA_DIR, "uploads.json");
const LOGO_PATH = path.join(LOGO_DIR, "current-logo.png");

function logInfo(message, details) {
  if (details) {
    console.log(`[IncaBar QR] ${message}`, details);
    return;
  }

  console.log(`[IncaBar QR] ${message}`);
}

function normalizeSlug(input) {
  const fallback = slugify(input || "item", {
    lower: true,
    strict: true,
    trim: true,
    locale: "pt"
  });

  return fallback || `item-${Date.now()}`;
}

function getExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

function isAllowedFile(file) {
  const extension = getExtension(file.originalname);
  return ALLOWED_MIME_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(extension);
}

function createUniqueSlug(baseSlug, existingSlugs) {
  let slug = baseSlug;
  let counter = 2;

  while (existingSlugs.has(slug)) {
    slug = `${baseSlug}-${counter}`;
    counter += 1;
  }

  existingSlugs.add(slug);
  return slug;
}

function createStoredFilename(originalName) {
  const ext = getExtension(originalName) || ".png";
  const base = normalizeSlug(path.parse(originalName).name);
  return `${base}-${Date.now()}-${Math.round(Math.random() * 1e6)}${ext}`;
}

async function ensureStructure() {
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(QRCODES_DIR);
  await fs.ensureDir(PUBLIC_DIR);
  await fs.ensureDir(LOGO_DIR);
  await fs.ensureDir(DATA_DIR);

  if (!(await fs.pathExists(MANIFEST_PATH))) {
    await fs.writeJson(MANIFEST_PATH, [], { spaces: 2 });
  }
}

async function readManifest() {
  await ensureStructure();
  const data = await fs.readJson(MANIFEST_PATH);
  return Array.isArray(data) ? data : [];
}

async function writeManifest(entries) {
  await fs.writeJson(MANIFEST_PATH, entries, { spaces: 2 });
}

async function getCurrentLogo() {
  return (await fs.pathExists(LOGO_PATH)) ? LOGO_PATH : null;
}

function buildPublicMessageUrl(slug) {
  return `${BASE_URL}/mensagem/${slug}`;
}

function buildFileUrl(folder, filename) {
  return `/${folder}/${encodeURIComponent(filename)}`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function getDashboardEntries() {
  const manifest = await readManifest();

  return Promise.all(
    manifest.map(async (entry) => {
      const qrFilename = `${entry.slug}-qr.png`;
      const qrPath = path.join(QRCODES_DIR, qrFilename);
      const qrExists = await fs.pathExists(qrPath);

      return {
        ...entry,
        status: qrExists ? "QR Code gerado" : "Enviado",
        publicUrl: buildPublicMessageUrl(entry.slug),
        imageUrl: buildFileUrl("uploads", entry.storedFilename),
        qrUrl: qrExists ? buildFileUrl("qrcodes", qrFilename) : null,
        qrFilename
      };
    })
  );
}

function renderLayout({ title, body, notice, error }) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin.css" />
</head>
<body>
  ${notice ? `<div class="toast toast-success">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="toast toast-error">${escapeHtml(error)}</div>` : ""}
  ${body}
</body>
</html>`;
}

function renderAdminPage(entries, notice, error, logoExists) {
  const hasEntries = entries.length > 0;
  const rows = hasEntries
    ? entries
        .map(
          (entry) => `
            <tr>
              <td>
                <div class="thumb-card">
                  <img src="${entry.imageUrl}" alt="${escapeHtml(entry.originalName)}" class="thumb-image" />
                </div>
              </td>
              <td>
                <div class="cell-stack">
                  <strong>${escapeHtml(entry.originalName)}</strong>
                  <span>${escapeHtml(entry.storedFilename)}</span>
                </div>
              </td>
              <td><code>${escapeHtml(entry.slug)}</code></td>
              <td>
                <a href="${entry.publicUrl}" target="_blank" rel="noreferrer">${escapeHtml(entry.publicUrl)}</a>
              </td>
              <td>
                ${
                  entry.qrUrl
                    ? `<div class="thumb-card thumb-card-qr"><img src="${entry.qrUrl}" alt="QR ${escapeHtml(entry.slug)}" class="thumb-image thumb-qr" /></div>`
                    : `<span class="muted">Aguardando geração</span>`
                }
              </td>
              <td>
                <span class="status ${entry.qrUrl ? "status-ready" : "status-pending"}">${escapeHtml(entry.status)}</span>
              </td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <h3>Nenhuma imagem enviada ainda</h3>
            <p>Envie as imagens da carta, mensagem ou cardápio para começar a gerar os QR Codes.</p>
          </div>
        </td>
      </tr>
    `;

  const body = `
    <main class="shell">
      <section class="hero">
        <div>
          <p class="eyebrow">Inca Bar · Painel Administrativo</p>
          <h1>Gerador de QR Codes</h1>
          <p class="hero-copy">Suba as imagens, aplique um logo opcional e gere QR Codes premium prontos para impressão e uso no domínio oficial do bar.</p>
        </div>
        <div class="hero-card">
          <span class="hero-label">Domínio ativo</span>
          <strong>${escapeHtml(BASE_URL)}</strong>
          <span class="hero-meta">${logoExists ? "Logo customizado carregado" : "QR Code padrão sem logo"}</span>
        </div>
      </section>

      <section class="panel actions-panel">
        <div class="panel-header">
          <div>
            <h2>Ações rápidas</h2>
            <p>Fluxo pensado para subir imagens, gerar tudo em lote e baixar os arquivos finais.</p>
          </div>
        </div>

        <div class="actions-grid">
          <form action="/admin/upload-images" method="POST" enctype="multipart/form-data" class="action-card">
            <h3>Enviar imagens</h3>
            <p>Aceita <code>.png</code>, <code>.jpg</code>, <code>.jpeg</code> e <code>.webp</code> com até 10 MB por arquivo.</p>
            <input type="file" name="images" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple required />
            <button type="submit">Enviar imagens</button>
          </form>

          <form action="/admin/upload-logo" method="POST" enctype="multipart/form-data" class="action-card">
            <h3>Enviar logo</h3>
            <p>O logo é centralizado com proteção visual para preservar a leitura do QR Code.</p>
            <input type="file" name="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" required />
            <button type="submit">Enviar logo</button>
          </form>

          <form action="/admin/generate-qrcodes" method="POST" class="action-card">
            <h3>Criar QR Codes</h3>
            <p>Gera arquivos PNG em alta resolução usando <code>errorCorrectionLevel: "H"</code>.</p>
            <button type="submit">Criar QR Codes</button>
          </form>

          <a href="/admin/download-qrcodes" class="action-card action-link">
            <h3>Baixar QR Codes</h3>
            <p>Baixa um ZIP com nomes amigáveis para impressão e distribuição.</p>
            <span class="button-like">Baixar ZIP</span>
          </a>
        </div>
      </section>

      <section class="panel">
        <div class="panel-header">
          <div>
            <h2>Imagens e QR Codes</h2>
            <p>${hasEntries ? `${entries.length} item(ns) cadastrados.` : "Os uploads aparecerão aqui assim que forem enviados."}</p>
          </div>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Miniatura</th>
                <th>Nome original</th>
                <th>Slug</th>
                <th>Link público</th>
                <th>Preview do QR</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              ${rows}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  `;

  return renderLayout({
    title: "Painel de QR Codes | Inca Bar",
    body,
    notice,
    error
  });
}

function renderMessagePage(entry) {
  const imageUrl = buildFileUrl("uploads", entry.storedFilename);

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(entry.originalName)} | Inca Bar</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6efe6;
      --card: rgba(255, 255, 255, 0.88);
      --ink: #1f1a17;
      --muted: #6e6258;
      --accent: #ae6a2c;
      --border: rgba(84, 58, 31, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background:
        radial-gradient(circle at top, rgba(229, 190, 144, 0.35), transparent 40%),
        linear-gradient(180deg, #fcf8f4 0%, var(--bg) 100%);
      font-family: Arial, sans-serif;
      color: var(--ink);
      padding: 24px;
    }
    .frame {
      width: min(100%, 960px);
      background: var(--card);
      border: 1px solid var(--border);
      border-radius: 28px;
      box-shadow: 0 25px 60px rgba(50, 31, 12, 0.12);
      padding: clamp(16px, 4vw, 32px);
    }
    .label {
      display: inline-flex;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(174, 106, 44, 0.12);
      color: var(--accent);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    h1 {
      font-size: clamp(28px, 4vw, 44px);
      margin: 16px 0 8px;
    }
    p {
      margin: 0 0 24px;
      color: var(--muted);
      line-height: 1.6;
    }
    img {
      width: 100%;
      height: auto;
      display: block;
      border-radius: 22px;
      object-fit: contain;
      background: white;
    }
  </style>
</head>
<body>
  <main class="frame">
    <span class="label">Inca Bar</span>
    <h1>${escapeHtml(entry.originalName)}</h1>
    <p>Mensagem publicada a partir do QR Code individual deste item.</p>
    <img src="${imageUrl}" alt="${escapeHtml(entry.originalName)}" />
  </main>
</body>
</html>`;
}

function renderNotFoundPage(slug) {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Mensagem não encontrada | Inca Bar</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      background: #f7f0e8;
      font-family: Arial, sans-serif;
      color: #2d241d;
      padding: 24px;
    }
    .card {
      max-width: 560px;
      background: white;
      border-radius: 24px;
      padding: 32px;
      box-shadow: 0 20px 50px rgba(52, 33, 14, 0.12);
      text-align: center;
    }
    a {
      color: #a45d21;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Mensagem não encontrada</h1>
    <p>Não encontramos nenhuma imagem publicada para o slug <strong>${escapeHtml(slug)}</strong>.</p>
    <p><a href="${escapeHtml(BASE_URL)}">Voltar para o site</a></p>
  </div>
</body>
</html>`;
}

function redirectWithMessage(res, type, message) {
  const params = new URLSearchParams({ [type]: message });
  res.redirect(`/admin/qrcodes?${params.toString()}`);
}

function createImageUploadMiddleware() {
  const storage = multer.diskStorage({
    destination: async (req, file, cb) => {
      try {
        await fs.ensureDir(UPLOADS_DIR);
        cb(null, UPLOADS_DIR);
      } catch (error) {
        cb(error);
      }
    },
    filename: (req, file, cb) => {
      cb(null, createStoredFilename(file.originalname));
    }
  });

  return multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, cb) => {
      if (isAllowedFile(file)) {
        return cb(null, true);
      }

      return cb(new Error("Formato inválido. Use PNG, JPG, JPEG ou WEBP."));
    }
  });
}

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    if (isAllowedFile(file)) {
      return cb(null, true);
    }

    return cb(new Error("Formato de logo inválido. Use PNG, JPG, JPEG ou WEBP."));
  }
});

async function generateQrWithOptionalLogo(url, logoPath) {
  const qrBuffer = await QRCode.toBuffer(url, {
    type: "png",
    width: 1000,
    margin: 2,
    errorCorrectionLevel: "H",
    color: {
      dark: "#2A1B12",
      light: "#FFFFFFFF"
    }
  });

  if (!logoPath) {
    return qrBuffer;
  }

  const logoSize = 220;
  const safeBackdrop = Buffer.from(`
    <svg width="${logoSize}" height="${logoSize}" viewBox="0 0 ${logoSize} ${logoSize}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${logoSize}" height="${logoSize}" rx="42" fill="white" />
    </svg>
  `);

  const logoBuffer = await sharp(logoPath)
    .resize(150, 150, { fit: "contain", withoutEnlargement: true })
    .png()
    .toBuffer();

  return sharp(qrBuffer)
    .composite([
      {
        input: safeBackdrop,
        gravity: "center"
      },
      {
        input: logoBuffer,
        gravity: "center"
      }
    ])
    .png()
    .toBuffer();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/qrcodes", express.static(QRCODES_DIR));

app.get("/", (req, res) => {
  res.redirect("/admin/qrcodes");
});

app.get("/admin/qrcodes", async (req, res, next) => {
  try {
    const entries = await getDashboardEntries();
    const logoExists = Boolean(await getCurrentLogo());
    res.send(renderAdminPage(entries, req.query.notice, req.query.error, logoExists));
  } catch (error) {
    next(error);
  }
});

app.post("/admin/upload-images", createImageUploadMiddleware().array("images", 100), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return redirectWithMessage(res, "error", "Selecione ao menos uma imagem para enviar.");
    }

    const manifest = await readManifest();
    const usedSlugs = new Set(manifest.map((item) => item.slug));
    const newEntries = req.files.map((file) => {
      const baseSlug = normalizeSlug(path.parse(file.originalname).name);
      const slug = createUniqueSlug(baseSlug, usedSlugs);

      return {
        slug,
        originalName: file.originalname,
        storedFilename: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        createdAt: new Date().toISOString()
      };
    });

    await writeManifest([...manifest, ...newEntries]);
    logInfo("Imagens enviadas com sucesso.", { total: newEntries.length });
    return redirectWithMessage(res, "notice", `${newEntries.length} imagem(ns) enviada(s) com sucesso.`);
  } catch (error) {
    next(error);
  }
});

app.post("/admin/upload-logo", logoUpload.single("logo"), async (req, res, next) => {
  try {
    if (!req.file) {
      return redirectWithMessage(res, "error", "Selecione um arquivo de logo para enviar.");
    }

    await fs.ensureDir(LOGO_DIR);
    await sharp(req.file.buffer)
      .resize(500, 500, { fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(LOGO_PATH);

    logInfo("Logo atualizado com sucesso.");
    return redirectWithMessage(res, "notice", "Logo enviado com sucesso e pronto para uso nos QR Codes.");
  } catch (error) {
    next(error);
  }
});

app.post("/admin/generate-qrcodes", async (req, res, next) => {
  try {
    const manifest = await readManifest();

    if (manifest.length === 0) {
      return redirectWithMessage(res, "error", "Envie imagens antes de gerar os QR Codes.");
    }

    await fs.ensureDir(QRCODES_DIR);
    const logoPath = await getCurrentLogo();

    for (const entry of manifest) {
      const url = buildPublicMessageUrl(entry.slug);
      const outputPath = path.join(QRCODES_DIR, `${entry.slug}-qr.png`);
      const qrBuffer = await generateQrWithOptionalLogo(url, logoPath);
      await fs.writeFile(outputPath, qrBuffer);
      logInfo("QR Code gerado.", { slug: entry.slug, outputPath });
    }

    return redirectWithMessage(res, "notice", `${manifest.length} QR Code(s) gerado(s) com sucesso.`);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/download-qrcodes", async (req, res, next) => {
  try {
    const manifest = await readManifest();
    const files = [];

    for (const entry of manifest) {
      const qrFilename = `${entry.slug}-qr.png`;
      const qrPath = path.join(QRCODES_DIR, qrFilename);

      if (await fs.pathExists(qrPath)) {
        files.push({ path: qrPath, name: qrFilename });
      }
    }

    if (files.length === 0) {
      return redirectWithMessage(res, "error", "Nenhum QR Code disponível para download. Gere os arquivos primeiro.");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=qrcodes-incabar.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("error", (error) => next(error));
    archive.pipe(res);

    for (const file of files) {
      archive.file(file.path, { name: file.name });
    }

    logInfo("Iniciando download do ZIP de QR Codes.", { total: files.length });
    await archive.finalize();
  } catch (error) {
    next(error);
  }
});

app.get("/mensagem/:slug", async (req, res, next) => {
  try {
    const manifest = await readManifest();
    const entry = manifest.find((item) => item.slug === req.params.slug);

    if (!entry) {
      return res.status(404).send(renderNotFoundPage(req.params.slug));
    }

    return res.send(renderMessagePage(entry));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? "Um ou mais arquivos excedem o limite de 10 MB."
        : "Falha ao processar o upload enviado.";

    logInfo("Erro de upload.", { code: error.code, message: error.message });
    return redirectWithMessage(res, "error", message);
  }

  if (error) {
    logInfo("Erro na aplicação.", { message: error.message });

    if (req.path.startsWith("/admin")) {
      return redirectWithMessage(res, "error", error.message || "Ocorreu um erro inesperado.");
    }

    return res.status(500).send("Erro interno do servidor.");
  }

  next();
});

ensureStructure()
  .then(() => {
    app.listen(PORT, () => {
      logInfo(`Servidor iniciado em http://localhost:${PORT}`);
      logInfo(`BASE_URL configurada para ${BASE_URL}`);
    });
  })
  .catch((error) => {
    console.error("[IncaBar QR] Falha ao iniciar a aplicação.", error);
    process.exit(1);
  });
