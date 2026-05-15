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

function getEntryType(entry) {
  return entry.entryType || "image";
}

function isImageEntry(entry) {
  return getEntryType(entry) === "image";
}

function isUrlEntry(entry) {
  return getEntryType(entry) === "url";
}

function normalizeExternalUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;

  try {
    const parsed = new URL(withProtocol);
    return parsed.toString();
  } catch (error) {
    return "";
  }
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
        entryType: getEntryType(entry),
        status: qrExists ? "QR gerado" : isUrlEntry(entry) ? "Link cadastrado" : "Enviado",
        publicUrl: isUrlEntry(entry) ? entry.targetUrl : buildPublicMessageUrl(entry.slug),
        imageUrl: isImageEntry(entry) && entry.storedFilename ? buildFileUrl("uploads", entry.storedFilename) : null,
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
    }
  };
}

async function removeFileIfExists(filePath) {
  if (await fs.pathExists(filePath)) {
    await fs.remove(filePath);
  }
}

async function removeEntryAssets(entry) {
  const qrPath = path.join(QRCODES_DIR, `${entry.slug}-qr.png`);
  if (entry.storedFilename) {
    const uploadPath = path.join(UPLOADS_DIR, entry.storedFilename);
    await removeFileIfExists(uploadPath);
  }
  await removeFileIfExists(qrPath);
}

async function recalculateStateFromEntries(entries) {
  const latestGeneratedAt = entries
    .map((entry) => entry.qrGeneratedAt)
    .filter(Boolean)
    .sort()
    .pop() || null;

  await writeState({ lastGenerationAt: latestGeneratedAt });
}

async function deleteEntriesBySlugs(slugs) {
  const manifest = await readManifest();
  const slugSet = new Set(slugs);
  const entriesToDelete = manifest.filter((entry) => slugSet.has(entry.slug));

  for (const entry of entriesToDelete) {
    await removeEntryAssets(entry);
  }

  const nextManifest = manifest.filter((entry) => !slugSet.has(entry.slug));
  await writeManifest(nextManifest);
  await recalculateStateFromEntries(nextManifest);

  return entriesToDelete.length;
}

async function clearHistory() {
  const manifest = await readManifest();

  for (const entry of manifest) {
    await removeEntryAssets(entry);
  }

  await writeManifest([]);
  await writeState({ lastGenerationAt: null });
  await fs.ensureDir(UPLOADS_DIR);
  await fs.ensureDir(QRCODES_DIR);

  return manifest.length;
}

function buildInitialToastConfig(notice, error) {
  if (notice && typeof notice === "object") {
    return notice;
  }

  if (error && typeof error === "object") {
    return error;
  }

  if (notice) {
    return {
      type: "success",
      title: "Sucesso",
      message: notice
    };
  }

  if (error) {
    return {
      type: "error",
      title: "Erro",
      message: error
    };
  }

  return null;
}

function renderLayout({ title, body, notice, error }) {
  const initialToast = buildInitialToastConfig(notice, error);

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
  <div class="notification-center" id="notification-center" aria-live="polite" aria-atomic="true"></div>
  ${body}
  <script>
    (() => {
      const MAX_VISIBLE_TOASTS = 3;
      const AUTO_CLOSE_MS = 4000;
      const initialToast = ${JSON.stringify(initialToast)};
      const notificationCenter = document.getElementById("notification-center");
      const queue = [];
      const activeToasts = new Set();

      function getToastIcon(type) {
        const icons = {
          success: "✓",
          error: "!",
          warning: "!",
          info: "i"
        };

        return icons[type] || "i";
      }

      function showNextToast() {
        while (activeToasts.size < MAX_VISIBLE_TOASTS && queue.length > 0) {
          const toast = queue.shift();
          renderToast(toast);
        }
      }

      function renderToast(toast) {
        const item = document.createElement("article");
        item.className = "notification-toast notification-" + toast.type;
        item.innerHTML =
          '<div class="notification-icon" aria-hidden="true">' + getToastIcon(toast.type) + '</div>' +
          '<div class="notification-content">' +
            '<strong>' + toast.title + '</strong>' +
            '<p>' + toast.message + '</p>' +
          '</div>' +
          '<button type="button" class="notification-close" aria-label="Fechar">×</button>';

        notificationCenter.appendChild(item);
        activeToasts.add(item);

        let closing = false;
        let remaining = AUTO_CLOSE_MS;
        let timeoutId = null;
        let startedAt = Date.now();

        function closeToast() {
          if (closing) {
            return;
          }

          closing = true;
          item.classList.add("is-leaving");
          window.setTimeout(() => {
            item.remove();
            activeToasts.delete(item);
            showNextToast();
          }, 260);
        }

        function startTimer() {
          startedAt = Date.now();
          timeoutId = window.setTimeout(closeToast, remaining);
        }

        function pauseTimer() {
          if (!timeoutId) {
            return;
          }

          window.clearTimeout(timeoutId);
          timeoutId = null;
          remaining -= Date.now() - startedAt;
        }

        item.addEventListener("mouseenter", pauseTimer);
        item.addEventListener("mouseleave", () => {
          if (!closing) {
            startTimer();
          }
        });

        item.querySelector(".notification-close").addEventListener("click", closeToast);
        window.requestAnimationFrame(() => item.classList.add("is-visible"));
        startTimer();
      }

      function showToast(config) {
        if (!config || !config.title || !config.message) {
          return;
        }

        queue.push({
          type: config.type || "info",
          title: config.title,
          message: config.message
        });

        showNextToast();
      }

      function rememberToast(config) {
        try {
          const key = "incabar:pending-toasts";
          const pending = JSON.parse(sessionStorage.getItem(key) || "[]");
          pending.push(config);
          sessionStorage.setItem(key, JSON.stringify(pending));
        } catch (error) {
          console.warn("Nao foi possivel persistir toast.", error);
        }
      }

      function flushRememberedToasts() {
        try {
          const key = "incabar:pending-toasts";
          const pending = JSON.parse(sessionStorage.getItem(key) || "[]");
          sessionStorage.removeItem(key);
          pending.forEach(showToast);
        } catch (error) {
          console.warn("Nao foi possivel recuperar toasts pendentes.", error);
        }
      }

      window.NotificationCenter = {
        showToast,
        rememberToast
      };
      window.showToast = showToast;

      flushRememberedToasts();

      if (initialToast) {
        showToast(initialToast);
      }
    })();
  </script>
</body>
</html>`;
}

function renderAdminPage(viewModel, notice, error) {
  const { entries, stats } = viewModel;
  const hasEntries = entries.length > 0;

  const rows = hasEntries
    ? entries
        .map(
          (entry) => `
            <tr data-row-slug="${escapeHtml(entry.slug)}">
              <td class="checkbox-cell">
                <input type="checkbox" class="row-checkbox" value="${escapeHtml(entry.slug)}" aria-label="Selecionar ${escapeHtml(entry.slug)}" />
              </td>
              <td>
                ${
                  entry.imageUrl
                    ? `<div class="thumb-card"><img src="${entry.imageUrl}" alt="${escapeHtml(entry.originalName)}" class="thumb-image" /></div>`
                    : `<div class="thumb-card thumb-card-link"><span>URL</span></div>`
                }
              </td>
              <td>
                <div class="cell-stack">
                  <strong>${escapeHtml(entry.originalName)}</strong>
                  <span>${escapeHtml(entry.storedFilename || entry.targetUrl || "")}</span>
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
        <td colspan="7">
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
            <p class="eyebrow">Inca Bar</p>
            <h1>Aplicação para Gerar QR Codes</h1>
            <p class="hero-copy">Suba várias imagens, envie o logo, gere os QR Codes em lote e baixe tudo pronto para impressão.</p>
          </div>

          <div class="hero-side">
            <article class="stat-card">
              <span class="stat-label">Última geração</span>
              <strong>${escapeHtml(formatDateTime(stats.lastGenerationAt))}</strong>
              <span class="stat-meta">Atualizado sempre que o lote é recriado</span>
            </article>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Ações</h2>
              <p>Fluxo completo para upload, personalização, geração e download dos QR Codes.</p>
            </div>
          </div>

          <div class="actions-grid">
            <form action="/admin/upload-images" method="POST" enctype="multipart/form-data" class="action-card action-card-step">
              <div class="action-step-head">
                <span class="action-step-badge">Passo 1</span>
                <span class="action-step-line" aria-hidden="true"></span>
              </div>
              <div class="action-card-body">
                <h3>Enviar imagens</h3>
                <p>Faça upload de uma ou várias imagens para gerar QR Codes individuais.</p>
                <span class="action-helper">PNG, JPG, JPEG ou WEBP • até 10 MB por arquivo</span>
              </div>
              <label class="upload-field">
                <input type="file" name="images" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" multiple required data-upload-input />
                <span class="upload-field-icon" aria-hidden="true">↑</span>
                <span class="upload-field-copy">
                  <strong>Clique para selecionar</strong>
                  <span>ou arraste arquivos aqui</span>
                </span>
                <span class="upload-field-status" data-empty-text="Nenhum arquivo selecionado">Nenhum arquivo selecionado</span>
              </label>
              <button type="submit" class="action-cta">Enviar imagens</button>
            </form>

            <form action="/admin/upload-logo" method="POST" enctype="multipart/form-data" class="action-card action-card-step">
              <div class="action-step-head">
                <span class="action-step-badge">Passo 2</span>
                <span class="action-step-line" aria-hidden="true"></span>
              </div>
              <div class="action-card-body">
                <h3>Enviar logo</h3>
                <p>Adicione uma imagem central para personalizar os QR Codes com a identidade do bar.</p>
                <span class="action-helper">Logo substitui automaticamente o anterior</span>
              </div>
              <label class="upload-field">
                <input type="file" name="logo" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp" required data-upload-input />
                <span class="upload-field-icon" aria-hidden="true">↑</span>
                <span class="upload-field-copy">
                  <strong>Clique para selecionar</strong>
                  <span>ou arraste arquivos aqui</span>
                </span>
                <span class="upload-field-status" data-empty-text="Nenhum arquivo selecionado">Nenhum arquivo selecionado</span>
              </label>
              <button type="submit" class="action-cta">Enviar logo</button>
            </form>

            <form action="/admin/add-link" method="POST" class="action-card action-card-step">
              <div class="action-step-head">
                <span class="action-step-badge">Passo 3</span>
                <span class="action-step-line" aria-hidden="true"></span>
              </div>
              <div class="action-card-body">
                <h3>Adicionar link</h3>
                <p>Cadastre uma URL de site ou aplicativo web para gerar um QR Code direto para esse endereço.</p>
                <span class="action-helper">Aceita links externos com https:// ou domínio simples</span>
              </div>
              <div class="action-form-fields">
                <input type="text" name="linkLabel" class="text-field" placeholder="Nome do link" maxlength="120" required />
                <input type="url" name="linkUrl" class="text-field" placeholder="https://meusite.com.br" required />
              </div>
              <button type="submit" class="action-cta">Salvar link</button>
            </form>

            <form action="/admin/generate-qrcodes" method="POST" class="action-card action-card-step">
              <div class="action-step-head">
                <span class="action-step-badge">Passo 4</span>
                <span class="action-step-line" aria-hidden="true"></span>
              </div>
              <div class="action-card-body">
                <h3>Criar QR Codes</h3>
                <p>Gere automaticamente QR Codes individuais a partir das imagens enviadas e dos links cadastrados.</p>
                <span class="action-helper">Alta resolução • Correção H • Compatível com impressão</span>
              </div>
              <div class="action-support action-support-static">
                <span class="action-support-chip">1000x1000 PNG</span>
                <span class="action-support-chip">Processamento em lote</span>
              </div>
              <button type="submit" class="action-cta">Gerar QR Codes</button>
            </form>

            <a href="/admin/download-qrcodes" class="action-card action-card-step action-link">
              <div class="action-step-head">
                <span class="action-step-badge">Passo 5</span>
              </div>
              <div class="action-card-body">
                <h3>Baixar QR Codes</h3>
                <p>Baixe todos os QR Codes gerados em um único arquivo ZIP.</p>
                <span class="action-helper">Download instantâneo do pacote completo</span>
              </div>
              <div class="action-support action-support-static">
                <span class="action-support-chip">qrcodes-incabar.zip</span>
                <span class="action-support-chip">Pronto para impressão</span>
              </div>
              <span class="button-like action-cta">Baixar ZIP</span>
            </a>
          </div>
        </section>

        <section class="panel">
          <div class="panel-header">
            <div>
              <h2>Galeria administrativa</h2>
              <p>${hasEntries ? `${entries.length} registro(s) acompanhados neste painel.` : "Os itens enviados aparecem aqui com link publico e preview do QR."}</p>
            </div>
            <div class="panel-tools">
              <button type="button" class="toolbar-button toolbar-button-danger" id="delete-selected-button" disabled>Excluir selecionados</button>
              <button type="button" class="toolbar-button" id="clear-history-button" ${hasEntries ? "" : "disabled"}>Limpar histórico</button>
            </div>
          </div>

          <div class="table-wrap">
            <table id="gallery-table">
              <thead>
                <tr>
                  <th class="checkbox-cell">
                    <input type="checkbox" id="select-all-checkbox" aria-label="Selecionar todos" ${hasEntries ? "" : "disabled"} />
                  </th>
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

        <div class="modal-backdrop" id="confirm-modal" hidden>
          <div class="modal-card" role="dialog" aria-modal="true" aria-labelledby="confirm-modal-title">
            <h3 id="confirm-modal-title"></h3>
            <p id="confirm-modal-copy"></p>
            <div class="modal-actions">
              <button type="button" class="toolbar-button toolbar-button-secondary" id="modal-cancel-button">Cancelar</button>
              <button type="button" class="toolbar-button toolbar-button-danger" id="modal-confirm-button">Confirmar exclusão</button>
            </div>
          </div>
        </div>
      </main>
      <script>
        (() => {
          const rowCheckboxes = Array.from(document.querySelectorAll(".row-checkbox"));
          const selectAllCheckbox = document.getElementById("select-all-checkbox");
          const deleteSelectedButton = document.getElementById("delete-selected-button");
          const clearHistoryButton = document.getElementById("clear-history-button");
          const modal = document.getElementById("confirm-modal");
          const modalTitle = document.getElementById("confirm-modal-title");
          const modalCopy = document.getElementById("confirm-modal-copy");
          const modalCancelButton = document.getElementById("modal-cancel-button");
          const modalConfirmButton = document.getElementById("modal-confirm-button");
          const uploadInputs = Array.from(document.querySelectorAll("[data-upload-input]"));
          const imageUploadForm = document.querySelector('form[action="/admin/upload-images"]');
          const logoUploadForm = document.querySelector('form[action="/admin/upload-logo"]');
          const linkForm = document.querySelector('form[action="/admin/add-link"]');
          const generateForm = document.querySelector('form[action="/admin/generate-qrcodes"]');
          const downloadLink = document.querySelector('a[href="/admin/download-qrcodes"]');

          let currentAction = null;

          function getSelectedSlugs() {
            return rowCheckboxes.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
          }

          function updateToolbar() {
            const selectedCount = getSelectedSlugs().length;
            deleteSelectedButton.disabled = selectedCount === 0;
            deleteSelectedButton.textContent = selectedCount > 0
              ? "Excluir selecionados (" + selectedCount + ")"
              : "Excluir selecionados";

            if (!selectAllCheckbox) {
              return;
            }

            const total = rowCheckboxes.length;
            const allChecked = total > 0 && selectedCount === total;
            const partiallyChecked = selectedCount > 0 && selectedCount < total;

            selectAllCheckbox.checked = allChecked;
            selectAllCheckbox.indeterminate = partiallyChecked;
          }

          function openModal(config) {
            currentAction = config.onConfirm;
            modalTitle.textContent = config.title;
            modalCopy.textContent = config.copy;
            modalConfirmButton.textContent = config.confirmLabel;
            modal.hidden = false;
            document.body.classList.add("modal-open");
          }

          function closeModal() {
            modal.hidden = true;
            currentAction = null;
            document.body.classList.remove("modal-open");
          }

          function updateUploadStatus(input) {
            const field = input.closest(".upload-field");
            if (!field) {
              return;
            }

            const status = field.querySelector(".upload-field-status");
            if (!status) {
              return;
            }

            const files = Array.from(input.files || []);
            if (files.length === 0) {
              status.textContent = status.dataset.emptyText || "Nenhum arquivo selecionado";
              field.classList.remove("has-files");
              return;
            }

            if (files.length === 1) {
              status.textContent = files[0].name + " selecionado";
            } else {
              status.textContent = files.length + " arquivos selecionados";
            }

            field.classList.add("has-files");
          }

          async function submitJson(url, payload) {
            const response = await fetch(url, {
              method: "POST",
              headers: {
                "Content-Type": "application/json"
              },
              body: JSON.stringify(payload)
            });

            if (!response.ok) {
              throw new Error("request_failed");
            }

            return response.json();
          }

          function pushReloadToast(toast) {
            if (window.NotificationCenter && typeof window.NotificationCenter.rememberToast === "function") {
              window.NotificationCenter.rememberToast(toast);
            }
          }

          function bindSubmitToast(form, toastConfig) {
            if (!form) {
              return;
            }

            form.addEventListener("submit", (event) => {
              if (form.dataset.submitting === "true") {
                return;
              }

              form.dataset.submitting = "true";
              event.preventDefault();

              if (window.showToast) {
                window.showToast(toastConfig);
              }

              window.setTimeout(() => form.submit(), 180);
            });
          }

          rowCheckboxes.forEach((checkbox) => {
            checkbox.addEventListener("change", updateToolbar);
          });

          uploadInputs.forEach((input) => {
            updateUploadStatus(input);
            input.addEventListener("change", () => updateUploadStatus(input));
          });

          bindSubmitToast(imageUploadForm, {
            type: "info",
            title: "Upload iniciado",
            message: "Processando envio dos arquivos..."
          });

          bindSubmitToast(logoUploadForm, {
            type: "info",
            title: "Informação",
            message: "Atualizando a personalização dos QR Codes..."
          });

          bindSubmitToast(linkForm, {
            type: "info",
            title: "Link em processamento",
            message: "Validando e cadastrando a URL informada..."
          });

          bindSubmitToast(generateForm, {
            type: "info",
            title: "Informação",
            message: "Processando geração dos QR Codes..."
          });

          if (downloadLink) {
            downloadLink.addEventListener("click", () => {
              if (window.showToast) {
                window.showToast({
                  type: "info",
                  title: "Download iniciado",
                  message: "Seu pacote ZIP está sendo preparado."
                });
              }
            });
          }

          if (selectAllCheckbox) {
            selectAllCheckbox.addEventListener("change", () => {
              rowCheckboxes.forEach((checkbox) => {
                checkbox.checked = selectAllCheckbox.checked;
              });
              updateToolbar();
            });
          }

          deleteSelectedButton.addEventListener("click", () => {
            const slugs = getSelectedSlugs();
            if (slugs.length === 0) {
              return;
            }

            openModal({
              title: "Deseja excluir os itens selecionados?",
              copy: "Essa ação removerá as imagens, os QR Codes e os links públicos vinculados aos registros selecionados. Essa ação não poderá ser desfeita.",
              confirmLabel: "Confirmar exclusão",
              onConfirm: async () => {
                const result = await submitJson("/admin/delete-selected", { slugs });
                if (result && result.success) {
                  pushReloadToast({
                    type: "success",
                    title: "Itens removidos",
                    message: "Os registros selecionados foram excluídos."
                  });
                  window.location.href = "/admin/qrcodes";
                  return;
                }
                throw new Error("request_failed");
              }
            });
          });

          clearHistoryButton.addEventListener("click", () => {
            openModal({
              title: "Deseja limpar todo o histórico?",
              copy: "Essa ação removerá todas as imagens, todos os QR Codes e todos os links públicos gerados. Essa ação não poderá ser desfeita.",
              confirmLabel: "Limpar histórico",
              onConfirm: async () => {
                const result = await submitJson("/admin/clear-history", {});
                if (result && result.success) {
                  pushReloadToast({
                    type: "success",
                    title: "Histórico limpo",
                    message: "Todos os registros foram removidos com sucesso."
                  });
                  window.location.href = "/admin/qrcodes";
                  return;
                }
                throw new Error("request_failed");
              }
            });
          });

          modalCancelButton.addEventListener("click", closeModal);
          modal.addEventListener("click", (event) => {
            if (event.target === modal) {
              closeModal();
            }
          });

          modalConfirmButton.addEventListener("click", async () => {
            if (!currentAction) {
              return;
            }

            modalConfirmButton.disabled = true;

            try {
              await currentAction();
            } catch (error) {
              if (window.showToast) {
                window.showToast({
                  type: "error",
                  title: "Erro",
                  message: "Não foi possível concluir a exclusão. Tente novamente."
                });
              }
            } finally {
              modalConfirmButton.disabled = false;
              closeModal();
            }
          });

          updateToolbar();
        })();
      </script>
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
  <title>Inca Bar</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      justify-content: center;
      align-items: center;
      padding: 20px;
      background: #f5f1eb;
      font-family: Inter, sans-serif;
    }
    .page {
      width: min(94vw, 900px);
      max-width: 94vw;
      box-sizing: border-box;
      background: white;
      border-radius: 24px;
      padding: clamp(16px, 4vw, 28px);
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.08);
      text-align: center;
    }
    .message-header {
      width: 100%;
      max-width: 100%;
      box-sizing: border-box;
      padding: 12px 14px;
      margin: 0 0 16px 0;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      border-radius: 18px;
      border-bottom: 1px solid rgba(139, 90, 43, 0.08);
      background: linear-gradient(180deg, rgba(255, 255, 255, 0.72), rgba(248, 243, 236, 0.58));
      backdrop-filter: blur(10px);
    }
    .brand-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      max-width: calc(100% - 64px);
      padding: 8px 14px;
      border-radius: 999px;
      background: #efe5da;
      color: #8b5a2b;
      font-size: clamp(12px, 3.2vw, 16px);
      font-weight: 700;
      letter-spacing: 0.12em;
      line-height: 1;
      white-space: nowrap;
    }
    .brand-logo {
      width: clamp(38px, 11vw, 52px);
      height: clamp(38px, 11vw, 52px);
      object-fit: contain;
      flex-shrink: 0;
    }
    .message-image {
      width: 100%;
      max-width: 100%;
      height: auto;
      max-height: 85vh;
      object-fit: contain;
      border-radius: 16px;
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.06);
      margin-top: 10px;
    }
    @media (max-width: 480px) {
      .message-header {
        padding: 10px 12px;
        gap: 10px;
        border-radius: 16px;
      }
      .brand-badge {
        padding: 8px 12px;
        font-size: 12px;
        letter-spacing: 0.08em;
      }
      .brand-logo {
        width: 40px;
        height: 40px;
      }
      .page {
        width: 94vw;
        max-width: 94vw;
        padding: 14px;
        border-radius: 24px;
      }
      .message-image {
        width: 100%;
        max-width: 100%;
        height: auto;
      }
    }
  </style>
</head>
<body>
  <main class="page">
    <header class="message-header">
      <div class="brand-badge">INCA BAR</div>
      <img src="/brand/inca-logo.png" alt="Logo Inca Bar" class="brand-logo" />
    </header>
    <img src="${imageUrl}" alt="Mensagem Inca Bar" class="message-image" />
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

function redirectWithToast(res, config) {
  const key = config.type === "error" ? "error" : "notice";
  const payload = JSON.stringify({
    type: config.type,
    title: config.title,
    message: config.message
  });
  const params = new URLSearchParams({ [key]: payload });

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
    const parseToast = (value) => {
      if (!value) {
        return null;
      }

      try {
        return JSON.parse(value);
      } catch (error) {
        return value;
      }
    };

    res.send(renderAdminPage(viewModel, parseToast(req.query.notice), parseToast(req.query.error)));
  } catch (error) {
    next(error);
  }
});

app.post("/admin/upload-images", createImageUploadMiddleware().array("images", 100), async (req, res, next) => {
  try {
    if (!req.files || req.files.length === 0) {
      return redirectWithToast(res, {
        type: "warning",
        title: "Atenção",
        message: "Selecione ao menos uma imagem para enviar."
      });
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
    return redirectWithToast(res, {
      type: "success",
      title: "Upload concluído",
      message: "Arquivos enviados com sucesso."
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/upload-logo", logoUpload.single("logo"), async (req, res, next) => {
  try {
    if (!req.file) {
      return redirectWithToast(res, {
        type: "warning",
        title: "Atenção",
        message: "Selecione um arquivo de logo para enviar."
      });
    }

    await fs.ensureDir(BRANDING_DIR);
    await sharp(req.file.buffer)
      .resize(600, 600, { fit: "inside", withoutEnlargement: true })
      .png()
      .toFile(LOGO_PATH);

    logEvent("[LOGO OK]", "Logo atualizado com sucesso.", { file: LOGO_PATH });
    return redirectWithToast(res, {
      type: "success",
      title: "Logo atualizado",
      message: "A personalização dos QR Codes foi atualizada."
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/add-link", async (req, res, next) => {
  try {
    const label = String(req.body.linkLabel || "").trim();
    const targetUrl = normalizeExternalUrl(req.body.linkUrl);

    if (!label || !targetUrl) {
      return redirectWithToast(res, {
        type: "warning",
        title: "Atenção",
        message: "Informe um nome e uma URL válida para cadastrar o link."
      });
    }

    const manifest = await readManifest();
    const usedSlugs = new Set(manifest.map((entry) => entry.slug));
    const slug = createUniqueSlug(normalizeSlug(label), usedSlugs);

    const newEntry = {
      entryType: "url",
      slug,
      originalName: label,
      targetUrl,
      storedFilename: null,
      mimeType: "text/url",
      size: 0,
      createdAt: new Date().toISOString(),
      qrGeneratedAt: null
    };

    await writeManifest([...manifest, newEntry]);
    logEvent("[LINK OK]", "Link externo cadastrado com sucesso.", { slug, targetUrl });
    return redirectWithToast(res, {
      type: "success",
      title: "Link cadastrado",
      message: "A URL foi adicionada com sucesso e já pode gerar QR Code."
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/generate-qrcodes", async (req, res, next) => {
  try {
    const manifest = await readManifest();

    if (manifest.length === 0) {
      return redirectWithToast(res, {
        type: "warning",
        title: "Atenção",
        message: "Envie imagens antes de gerar os QR Codes."
      });
    }

    const logoPath = await getCurrentLogo();
    const generatedAt = new Date().toISOString();
    const updatedManifest = [];

    await fs.ensureDir(QRCODES_DIR);

    for (const entry of manifest) {
      const publicUrl = isUrlEntry(entry) ? entry.targetUrl : buildPublicMessageUrl(entry.slug);
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

    return redirectWithToast(res, {
      type: "success",
      title: "QR Codes gerados",
      message: `${updatedManifest.length} QR Codes gerados com sucesso.`
    });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/delete-selected", async (req, res, next) => {
  try {
    const slugs = Array.isArray(req.body.slugs) ? req.body.slugs.filter(Boolean) : [];

    if (slugs.length === 0) {
      return res.status(400).json({ success: false, message: "Nenhum slug informado." });
    }

    const deletedCount = await deleteEntriesBySlugs(slugs);
    logEvent("[DELETE OK]", "Itens selecionados excluidos com sucesso.", { total: deletedCount, slugs });
    return res.json({ success: true, deletedCount });
  } catch (error) {
    next(error);
  }
});

app.post("/admin/clear-history", async (req, res, next) => {
  try {
    const deletedCount = await clearHistory();
    logEvent("[DELETE OK]", "Historico limpo com sucesso.", { total: deletedCount });
    return res.json({ success: true, deletedCount });
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
      return redirectWithToast(res, {
        type: "warning",
        title: "Atenção",
        message: "Nenhum QR Code disponível para download. Gere os arquivos primeiro."
      });
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

    if (!entry || isUrlEntry(entry)) {
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
    return redirectWithToast(res, {
      type: "error",
      title: "Erro",
      message
    });
  }

  if (error) {
    logEvent("[ERROR]", "Falha inesperada na aplicacao.", { message: error.message, path: req.path });

    const expectsJson = req.path === "/admin/delete-selected" || req.path === "/admin/clear-history";
    if (expectsJson) {
      return res.status(500).json({ success: false, message: "Nao foi possivel concluir a exclusao." });
    }

    if (req.path.startsWith("/admin")) {
      return redirectWithToast(res, {
        type: "error",
        title: "Erro",
        message: error.message || "Não foi possível concluir a operação."
      });
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
