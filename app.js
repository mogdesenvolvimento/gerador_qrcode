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

const PORT = process.env.PORT || 3000;
const RAW_BASE_URL = process.env.BASE_URL || "";
const RAILWAY_PUBLIC_DOMAIN = process.env.RAILWAY_PUBLIC_DOMAIN || "";
const NODE_ENV = process.env.NODE_ENV || "development";
const MAX_FILE_SIZE = 10 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp"
]);
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

const ROOT_DIR = __dirname;
const PUBLIC_DIR = path.join(ROOT_DIR, "public");
const DATA_DIR = path.join(ROOT_DIR, "data");
const UPLOADS_DIR = path.join(ROOT_DIR, "uploads");
const OUTPUTS_DIR = path.join(ROOT_DIR, "outputs");
const QRCODES_DIR = path.join(OUTPUTS_DIR, "qrcodes");
const BRANDING_DIR = path.join(ROOT_DIR, "branding");
const MANIFEST_PATH = path.join(DATA_DIR, "uploads.json");
const STATE_PATH = path.join(DATA_DIR, "state.json");
const LOGO_PATH = path.join(BRANDING_DIR, "logo.png");

function logEvent(label, message, details) {
  if (details) {
    console.log(`${label} ${message}`, details);
    return;
  }

  console.log(`${label} ${message}`);
}

function resolveBaseUrl() {
  const normalizedBaseUrl = RAW_BASE_URL.trim().replace(/\/+$/, "");
  if (normalizedBaseUrl) {
    return normalizedBaseUrl;
  }

  const normalizedRailwayDomain = RAILWAY_PUBLIC_DOMAIN.trim().replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (normalizedRailwayDomain) {
    return `https://${normalizedRailwayDomain}`;
  }

  return "";
}

const BASE_URL = resolveBaseUrl();

function assertBaseUrl() {
  if (!BASE_URL) {
    throw new Error("BASE_URL nao configurada e RAILWAY_PUBLIC_DOMAIN indisponivel. Defina BASE_URL no Railway ou no arquivo .env.");
  }
}

function getExtension(filename) {
  return path.extname(filename || "").toLowerCase();
}

function normalizeSlug(value) {
  const slug = slugify(value || "item", {
    lower: true,
    strict: true,
    trim: true,
    locale: "pt"
  });

  return slug || `item-${Date.now()}`;
}

function isAllowedFile(file) {
  const extension = getExtension(file.originalname);
  return ALLOWED_MIME_TYPES.has(file.mimetype) && ALLOWED_EXTENSIONS.has(extension);
}

function createUniqueSlug(baseSlug, existingSlugs) {
  let candidate = baseSlug;
  let index = 2;

  while (existingSlugs.has(candidate)) {
    candidate = `${baseSlug}-${index}`;
    index += 1;
  }

  existingSlugs.add(candidate);
  return candidate;
}

function createStoredFilename(originalName) {
  const extension = getExtension(originalName) || ".png";
  const base = normalizeSlug(path.parse(originalName).name);
  return `${base}-${Date.now()}-${Math.round(Math.random() * 1e6)}${extension}`;
}

function buildPublicMessageUrl(slug) {
  assertBaseUrl();
  return `${BASE_URL}/mensagem/${slug}`;
}

function buildFileUrl(folder, filename) {
  return `/${folder}/${encodeURIComponent(filename)}`;
}

function formatDateTime(value) {
  if (!value) {
    return "Ainda nao gerado";
  }

  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "America/Sao_Paulo"
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function ensureStructure() {
  await fs.ensureDir(PUBLIC_DIR);
  await fs.ensureDir(DATA_DIR);
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(OUTPUTS_DIR);
  await fs.ensureDir(QRCODES_DIR);
  await fs.ensureDir(BRANDING_DIR);

  if (!(await fs.pathExists(MANIFEST_PATH))) {
    await fs.writeJson(MANIFEST_PATH, [], { spaces: 2 });
  }

  if (!(await fs.pathExists(STATE_PATH))) {
    await fs.writeJson(STATE_PATH, { lastGenerationAt: null }, { spaces: 2 });
  }
}

async function readManifest() {
  await ensureStructure();
  const manifest = await fs.readJson(MANIFEST_PATH);
  return Array.isArray(manifest) ? manifest : [];
}

async function writeManifest(entries) {
  await fs.writeJson(MANIFEST_PATH, entries, { spaces: 2 });
}

async function readState() {
  await ensureStructure();
  const state = await fs.readJson(STATE_PATH);
  return {
    lastGenerationAt: state.lastGenerationAt || null
  };
}

async function writeState(state) {
  await fs.writeJson(STATE_PATH, state, { spaces: 2 });
}

async function getCurrentLogo() {
  return (await fs.pathExists(LOGO_PATH)) ? LOGO_PATH : null;
}

async function getDashboardViewModel() {
  const manifest = await readManifest();
  const state = await readState();
  let qrCount = 0;

  const entries = await Promise.all(
    manifest.map(async (entry) => {
      const qrFilename = `${entry.slug}-qr.png`;
      const qrPath = path.join(QRCODES_DIR, qrFilename);
      const qrExists = await fs.pathExists(qrPath);

      if (qrExists) {
        qrCount += 1;
      }

      return {
        ...entry,
        status: qrExists ? "QR gerado" : "Enviado",
        publicUrl: buildPublicMessageUrl(entry.slug),
        imageUrl: buildFileUrl("uploads", entry.storedFilename),
        qrUrl: qrExists ? buildFileUrl("qrcodes", qrFilename) : null
      };
    })
  );

  return {
    entries,
    stats: {
      totalImages: entries.length,
      totalGenerated: qrCount,
      lastGenerationAt: state.lastGenerationAt
    },
    logoExists: Boolean(await getCurrentLogo())
  };
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
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/admin.css" />
</head>
<body>
  ${notice ? `<div class="toast toast-success">${escapeHtml(notice)}</div>` : ""}
  ${error ? `<div class="toast toast-error">${escapeHtml(error)}</div>` : ""}
  ${body}
</body>
</html>`;
}

function renderAdminPage(viewModel, notice, error) {
  const { entries, stats, logoExists } = viewModel;
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
              <td><a href="${entry.publicUrl}" target="_blank" rel="noreferrer">${escapeHtml(entry.publicUrl)}</a></td>
              <td>
                ${
                  entry.qrUrl
                    ? `<div class="thumb-card thumb-card-qr"><img src="${entry.qrUrl}" alt="QR ${escapeHtml(entry.slug)}" class="thumb-image thumb-qr" /></div>`
                    : `<span class="muted">Aguardando geracao</span>`
                }
              </td>
              <td><span class="status ${entry.qrUrl ? "status-ready" : "status-pending"}">${escapeHtml(entry.status)}</span></td>
            </tr>
          `
        )
        .join("")
    : `
      <tr>
        <td colspan="6">
          <div class="empty-state">
            <h3>Nenhuma imagem enviada ainda</h3>
            <p>Envie as imagens para comecar a gerar os QR Codes do Inca Bar.</p>
          </div>
        </td>
      </tr>
    `;

  return renderLayout({
    title: "Painel QR Codes | Inca Bar",
    notice,
    error,
    body: `
      <main class="shell">
        <section class="hero">
          <div class="hero-copy-wrap">
            <p class="eyebrow">Inca Bar | QR Codes em producao</p>
            <h1>Painel administrativo premium para gerar QR Codes individuais.</h1>
            <p class="hero-copy">Suba varias imagens, envie o logo do bar, gere os QR Codes em lote e baixe tudo pronto para impressao no dominio oficial.</p>
            <div class="hero-badges">
              <span class="hero-pill">${escapeHtml(BASE_URL)}</span>
              <span class="hero-pill">${logoExists ? "Logo ativo" : "Sem logo enviado"}</span>
            </div>
          </div>

          <div class="stats-grid">
            <article class="stat-card">
              <span class="stat-label">Total de imagens</span>
              <strong>${stats.totalImages}</strong>
              <span class="stat-meta">Uploads prontos para publicacao</span>
            </article>
            <article class="stat-card">
              <span class="stat-label">QR gerados</span>
              <strong>${stats.totalGenerated}</strong>
              <span class="stat-meta">Arquivos prontos para impressao</span>
            </article>
            <article class="stat-card stat-card-wide">
              <span class="stat-label">Ultima geracao</span>
              <strong>${escapeHtml(formatDateTime(stats.lastGenerationAt))}</strong>
              <span class="stat-meta">Atualizado sempre que o lote e recriado</span>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Acoes</h2>
              <p>Fluxo completo para upload, branding, geracao e download em ZIP.</p>
            </div>
          </div>

          <div class="actions-grid">
            <form action="/admin/upload-images" method="POST" enctype="multipart/form-data" class="action-card">
              <h3>Enviar imagens</h3>
              <p>Upload multiplo com limite de 10 MB e slugs unicos para cada item.</p>
              <input type="file" name="images" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple required />
              <button type="submit">Enviar imagens</button>
            </form>

            <form action="/admin/upload-logo" method="POST" enctype="multipart/form-data" class="action-card">
              <h3>Enviar logo</h3>
              <p>Substitui o logo anterior e salva em <code>/branding/logo.png</code>.</p>
              <input type="file" name="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" required />
              <button type="submit">Enviar logo</button>
            </form>

            <form action="/admin/generate-qrcodes" method="POST" class="action-card">
              <h3>Criar QR Codes</h3>
              <p>Gera PNGs 1000x1000 em <code>/outputs/qrcodes</code> com correcao <code>H</code>.</p>
              <button type="submit">Criar QR Codes</button>
            </form>

            <a href="/admin/download-qrcodes" class="action-card action-link">
              <h3>Baixar QR Codes</h3>
              <p>Entrega instantanea do arquivo <code>qrcodes-incabar.zip</code>.</p>
              <span class="button-like">Baixar ZIP</span>
            </a>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Galeria administrativa</h2>
              <p>${hasEntries ? `${entries.length} registro(s) acompanhados neste painel.` : "Os itens enviados aparecem aqui com link publico e preview do QR."}</p>
            </div>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Imagem</th>
                  <th>Nome</th>
                  <th>Slug</th>
                  <th>Link publico</th>
                  <th>Preview QR</th>
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
    `
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
      --bg: #f7efe6;
      --ink: #22170f;
      --muted: #705f52;
      --line: rgba(90, 57, 28, 0.14);
      --brand: #a95b22;
      --surface: rgba(255, 255, 255, 0.92);
      --shadow: 0 24px 60px rgba(50, 31, 12, 0.16);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      font-family: "Outfit", Arial, sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(214, 172, 122, 0.32), transparent 32%),
        linear-gradient(180deg, #fffaf5 0%, var(--bg) 100%);
    }
    .frame {
      width: min(100%, 980px);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 28px;
      box-shadow: var(--shadow);
      overflow: hidden;
    }
    .content {
      padding: clamp(18px, 4vw, 34px);
    }
    .eyebrow {
      display: inline-flex;
      padding: 8px 12px;
      border-radius: 999px;
      background: rgba(169, 91, 34, 0.1);
      color: var(--brand);
      font-size: 12px;
      font-weight: 800;
      letter-spacing: 0.1em;
      text-transform: uppercase;
    }
    h1 {
      margin: 16px 0 10px;
      font-size: clamp(28px, 5vw, 48px);
      line-height: 1;
    }
    p {
      margin: 0 0 24px;
      color: var(--muted);
      line-height: 1.65;
      max-width: 58ch;
    }
    .image-wrap {
      background: white;
      border-top: 1px solid var(--line);
      padding: clamp(12px, 3vw, 22px);
    }
    img {
      display: block;
      width: 100%;
      height: auto;
      object-fit: contain;
      border-radius: 22px;
    }
  </style>
</head>
<body>
  <main class="frame">
    <div class="content">
      <span class="eyebrow">Inca Bar</span>
      <h1>${escapeHtml(entry.originalName)}</h1>
      <p>Pagina publica da mensagem vinculada a este QR Code individual. O conteudo foi otimizado para abrir bem no celular e manter a imagem centralizada.</p>
    </div>
    <div class="image-wrap">
      <img src="${imageUrl}" alt="${escapeHtml(entry.originalName)}" />
    </div>
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
  <title>Mensagem nao encontrada | Inca Bar</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 20px;
      background: linear-gradient(180deg, #fff9f4 0%, #f4eadf 100%);
      color: #2a1d14;
      font-family: Arial, sans-serif;
    }
    .card {
      max-width: 560px;
      background: white;
      border-radius: 24px;
      padding: 32px;
      text-align: center;
      box-shadow: 0 20px 50px rgba(52, 33, 14, 0.12);
    }
    h1 { margin-top: 0; }
    p {
      color: #6e6053;
      line-height: 1.7;
    }
    a {
      color: #a55c22;
      text-decoration: none;
      font-weight: 700;
    }
  </style>
</head>
<body>
  <section class="card">
    <h1>Mensagem nao encontrada</h1>
    <p>Nenhuma imagem foi localizada para o slug <strong>${escapeHtml(slug)}</strong>.</p>
    <p><a href="${escapeHtml(BASE_URL)}">Voltar para o dominio principal</a></p>
  </section>
</body>
</html>`;
}

function redirectWithMessage(res, type, message) {
  const params = new URLSearchParams({ [type]: message });
  res.redirect(`/admin/qrcodes?${params.toString()}`);
}

function createImageUploadMiddleware() {
  const storage = multer.diskStorage({
    destination: async (req, file, callback) => {
      try {
        await fs.ensureDir(UPLOADS_DIR);
        callback(null, UPLOADS_DIR);
      } catch (error) {
        callback(error);
      }
    },
    filename: (req, file, callback) => {
      callback(null, createStoredFilename(file.originalname));
    }
  });

  return multer({
    storage,
    limits: { fileSize: MAX_FILE_SIZE },
    fileFilter: (req, file, callback) => {
      if (isAllowedFile(file)) {
        callback(null, true);
        return;
      }

      callback(new Error("Formato invalido. Use PNG, JPG, JPEG ou WEBP."));
    }
  });
}

const logoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, callback) => {
    if (isAllowedFile(file)) {
      callback(null, true);
      return;
    }

    callback(new Error("Formato de logo invalido. Use PNG, JPG, JPEG ou WEBP."));
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

  const backdropSize = 220;
  const safeBackdrop = Buffer.from(`
    <svg width="${backdropSize}" height="${backdropSize}" viewBox="0 0 ${backdropSize} ${backdropSize}" xmlns="http://www.w3.org/2000/svg">
      <rect x="0" y="0" width="${backdropSize}" height="${backdropSize}" rx="46" fill="white" />
    </svg>
  `);

  const logoBuffer = await sharp(logoPath)
    .resize(150, 150, { fit: "contain", withoutEnlargement: true })
    .png()
    .toBuffer();

  return sharp(qrBuffer)
    .composite([
      { input: safeBackdrop, gravity: "center" },
      { input: logoBuffer, gravity: "center" }
    ])
    .png()
    .toBuffer();
}

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/qrcodes", express.static(QRCODES_DIR));
app.use("/branding", express.static(BRANDING_DIR));

app.get("/", (req, res) => {
  res.redirect("/admin/qrcodes");
});

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/admin/qrcodes", async (req, res, next) => {
  try {
    const viewModel = await getDashboardViewModel();
    res.send(renderAdminPage(viewModel, req.query.notice, req.query.error));
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
    const usedSlugs = new Set(manifest.map((entry) => entry.slug));

    const newEntries = req.files.map((file) => {
      const baseSlug = normalizeSlug(path.parse(file.originalname).name);
      const slug = createUniqueSlug(baseSlug, usedSlugs);

      return {
        slug,
        originalName: file.originalname,
        storedFilename: file.filename,
        mimeType: file.mimetype,
        size: file.size,
        createdAt: new Date().toISOString(),
        qrGeneratedAt: null
      };
    });

    await writeManifest([...manifest, ...newEntries]);
    logEvent("[UPLOAD OK]", "Imagens recebidas com sucesso.", { total: newEntries.length });
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

    await fs.ensureDir(BRANDING_DIR);
    await sharp(req.file.buffer)
      .resize(600, 600, { fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(LOGO_PATH);

    logEvent("[LOGO OK]", "Logo atualizado com sucesso.", { file: LOGO_PATH });
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

    const logoPath = await getCurrentLogo();
    const generatedAt = new Date().toISOString();
    const updatedManifest = [];

    await fs.ensureDir(QRCODES_DIR);

    for (const entry of manifest) {
      const publicUrl = buildPublicMessageUrl(entry.slug);
      const outputPath = path.join(QRCODES_DIR, `${entry.slug}-qr.png`);
      const qrBuffer = await generateQrWithOptionalLogo(publicUrl, logoPath);
      await fs.writeFile(outputPath, qrBuffer);
      updatedManifest.push({
        ...entry,
        qrGeneratedAt: generatedAt
      });
      logEvent("[QR GENERATED]", "QR Code salvo com sucesso.", { slug: entry.slug, outputPath, publicUrl });
    }

    await writeManifest(updatedManifest);
    await writeState({ lastGenerationAt: generatedAt });

    return redirectWithMessage(res, "notice", `${updatedManifest.length} QR Code(s) gerado(s) com sucesso.`);
  } catch (error) {
    next(error);
  }
});

app.get("/admin/download-qrcodes", async (req, res, next) => {
  try {
    const manifest = await readManifest();
    const files = [];

    for (const entry of manifest) {
      const filename = `${entry.slug}-qr.png`;
      const filePath = path.join(QRCODES_DIR, filename);

      if (await fs.pathExists(filePath)) {
        files.push({ filePath, filename });
      }
    }

    if (files.length === 0) {
      return redirectWithMessage(res, "error", "Nenhum QR Code disponivel para download. Gere os arquivos primeiro.");
    }

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", "attachment; filename=qrcodes-incabar.zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (error) => next(error));
    archive.pipe(res);

    for (const file of files) {
      archive.file(file.filePath, { name: file.filename });
    }

    logEvent("[ZIP READY]", "Gerando download do ZIP de QR Codes.", { total: files.length });
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

    const imagePath = path.join(UPLOADS_DIR, entry.storedFilename);
    if (!(await fs.pathExists(imagePath))) {
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

    logEvent("[ERROR]", "Erro de upload.", { code: error.code, message: error.message });
    return redirectWithMessage(res, "error", message);
  }

  if (error) {
    logEvent("[ERROR]", "Falha inesperada na aplicacao.", { message: error.message, path: req.path });

    if (req.path.startsWith("/admin")) {
      return redirectWithMessage(res, "error", error.message || "Ocorreu um erro inesperado.");
    }

    return res.status(500).send("Erro interno do servidor.");
  }

  next();
});

ensureStructure()
  .then(() => {
    assertBaseUrl();
    app.listen(PORT, "0.0.0.0", () => {
      logEvent("[START]", "Servidor iniciado com sucesso.", { port: PORT, baseUrl: BASE_URL, nodeEnv: NODE_ENV });
    });
  })
  .catch((error) => {
    logEvent("[ERROR]", "Falha ao iniciar a aplicacao.", { message: error.message });
    process.exit(1);
  });
