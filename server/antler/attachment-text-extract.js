// Extract plain text from uploaded buffers for RAG indexing.

const pdfParse = require('pdf-parse');

async function extractText(filename, buffer) {
  const ext = String(filename || '')
    .toLowerCase()
    .match(/\.[^.]+$/)?.[0] || '';
  if (ext === '.txt' || ext === '.md' || ext === '.csv' || ext === '.json') {
    return buffer.toString('utf8');
  }
  if (ext === '.pdf') {
    try {
      const d = await pdfParse(buffer);
      return d.text || '';
    } catch {
      return '';
    }
  }
  return '';
}

module.exports = { extractText };
