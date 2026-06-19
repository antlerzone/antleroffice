const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const PDFDocument = require('pdfkit');
const registry = require('./registry-store');
const materials = require('./materials.cjs');

function desktopDir() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    const desktop = path.join(home, 'Desktop');
    if (fs.existsSync(desktop)) return desktop;
    const oneDrive = path.join(home, 'OneDrive', 'Desktop');
    if (fs.existsSync(oneDrive)) return oneDrive;
    return desktop;
  }
  const desktop = path.join(home, 'Desktop');
  return fs.existsSync(desktop) ? desktop : home;
}

function safeFileName(name) {
  return String(name || 'standup')
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function formatDate(ts) {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return new Date(ts).toISOString().slice(0, 10);
  }
}

function buildPdfBuffer(deliverable) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const period = deliverable.reportPeriod;
    const title = period?.label
      ? `Department Standup — ${period.label}`
      : deliverable.summary || 'Department Standup';

    doc.fontSize(20).text(title, { align: 'left' });
    doc.moveDown(0.5);
    if (period) {
      doc
        .fontSize(11)
        .fillColor('#555555')
        .text(`${formatDate(period.from)} – ${formatDate(period.to)}`);
      doc.fillColor('#000000');
    }
    doc.moveDown(1);

    const sections = deliverable.standupSections || [];
    if (!sections.length && deliverable.content) {
      doc.fontSize(12).text(deliverable.content);
    }

    for (const section of sections) {
      doc.fontSize(14).fillColor('#111111').text(section.label || 'Section', { underline: true });
      doc.moveDown(0.35);
      doc.fontSize(11).fillColor('#000000').text(section.text || '', { align: 'left' });
      if (Array.isArray(section.followUps) && section.followUps.length) {
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#333333').text('Follow-ups:', { underline: true });
        for (const fu of section.followUps) {
          doc.moveDown(0.2);
          doc.text(`Q: ${fu.text || ''}`);
          if (fu.answer) doc.text(`A: ${fu.answer}`);
        }
        doc.fillColor('#000000');
      }
      doc.moveDown(1);
    }

    doc.end();
  });
}

function resolveOutputDir(dest = 'desktop') {
  if (dest === 'materials') {
    const root = materials.getRootPath();
    const dir = path.join(root, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }
  const dir = desktopDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function findLatestStandupDeliverable() {
  return registry
    .listDeliverables()
    .find((d) => d.kind === 'daily_report' && Array.isArray(d.standupSections) && d.standupSections.length);
}

async function exportStandupPdf(deliverableId, { dest = 'desktop' } = {}) {
  let item = deliverableId ? registry.getDeliverable(deliverableId) : findLatestStandupDeliverable();
  if (!item && deliverableId) item = registry.getDeliverable(deliverableId);
  if (!item) {
    const err = new Error('No standup report found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (!item.standupSections?.length && !item.content) {
    const err = new Error('Deliverable has no standup content');
    err.code = 'NO_CONTENT';
    throw err;
  }

  const periodLabel = item.reportPeriod?.label || 'standup';
  const stamp = new Date().toISOString().slice(0, 10);
  const fileName = `AntlerStandup-${safeFileName(periodLabel)}-${stamp}.pdf`;
  const outDir = resolveOutputDir(dest);
  const outPath = path.join(outDir, fileName);

  const buffer = await buildPdfBuffer(item);
  fs.writeFileSync(outPath, buffer);

  return {
    ok: true,
    path: outPath,
    fileName,
    deliverableId: item.id,
    dest,
  };
}

module.exports = {
  exportStandupPdf,
  findLatestStandupDeliverable,
  desktopDir,
};
