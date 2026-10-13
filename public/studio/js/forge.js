// public/studio/js/forge.js — 从 Forge 包导入 (DESIGN §32.12). A zip or a folder becomes a preview of the import report
// (POST /studio/api/forge/preview); confirming writes plugins/<id>/ (POST /studio/api/forge/import). The server never
// receives a path on its disk, and it never runs a script from the pack. The same studio key as every other change.

import { useEffect, useRef, useState } from '../../vendor/hooks.module.js';
import { html, Modal, Button } from '../../js/ui/components.js';
import { t } from '../../../shared/i18n.js';
import { post, fileBase64 } from './api.js';
import { errorText } from './issues.js';

/** The page refuses a pack bigger than this before it uploads (the server still enforces its own limit). */
const MAX_BYTES = 64 * 1024 * 1024;

/**
 * The dialog (see the header).
 * @param {{ open: boolean, onClose: () => void, onImported: (plugins: { id: string, class: string }[]) => void }} props
 */
export function ForgeDialog({ open, onClose, onImported }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [report, setReport] = useState(null);
  const [payload, setPayload] = useState(null);
  const zipRef = useRef(null);
  const dirRef = useRef(null);
  useEffect(() => {
    if (!open) return;
    setBusy(false); setError(''); setNote(''); setReport(null); setPayload(null);
    if (zipRef.current) zipRef.current.value = '';
    if (dirRef.current) dirRef.current.value = '';
  }, [open]);
  const tooBig = () => { setError(t('包太大，超过 {max}。', { max: '64 MB' })); setPayload(null); setReport(null); setNote(''); };
  const takeZip = async (file) => {
    if (!file) return;
    if (file.size > MAX_BYTES) { tooBig(); return; }
    setNote(t('正在读取 Forge 包…')); setError(''); setReport(null);
    try { setPayload({ zip: await fileBase64(file) }); }
    catch (e) { setError(errorText(e)); setPayload(null); }
    finally { setNote(''); }
  };
  const takeDir = async (list) => {
    const files = [...list];
    if (!files.length) return;
    let total = 0;
    for (const f of files) total += f.size;
    if (total > MAX_BYTES) { tooBig(); return; }
    setNote(t('正在读取 Forge 包…')); setError(''); setReport(null);
    try {
      const out = [];
      for (const f of files) {
        const rel = String(f.webkitRelativePath || f.name).replace(/\\/g, '/');
        const parts = rel.split('/').filter(Boolean);
        const name = parts.length > 1 ? parts.slice(1).join('/') : rel;
        out.push({ name, data: await fileBase64(f) });
      }
      setPayload({ files: out });
    } catch (e) { setError(errorText(e)); setPayload(null); }
    finally { setNote(''); }
  };
  const preview = async () => {
    if (!payload) return;
    setBusy(true); setError('');
    try { setReport((await post('forge/preview', payload)).report); }
    catch (e) { setReport(null); setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (!payload || !report?.products?.length) return;
    setBusy(true); setError('');
    try {
      const r = await post('forge/import', payload);
      setReport(r.report);
      if (!r.report?.ok || !r.report.products?.length) { setError(r.report?.check || t('这个包没有可以写入的插件。')); return; }
      setNote(t('已写入 {n} 个插件', { n: String((r.plugins || r.report.products).length) }));
      onImported(r.plugins || []);
    } catch (e) { setError(errorText(e)); }
    finally { setBusy(false); }
  };
  const canWrite = !!(report?.ok && report.products?.length);
  const actions = html`
    <${Button} onClick=${onClose} disabled=${busy}>${t('取消')}<//>
    <${Button} onClick=${preview} loading=${busy} disabled=${!payload || busy} data-testid="forge-preview">${t('预览导入报告')}<//>
    <${Button} variant="primary" onClick=${confirm} loading=${busy} disabled=${!canWrite || busy} data-testid="forge-confirm">${t('确认写入插件')}<//>`;
  return html`<${Modal} open=${open} title=${t('从 Forge 包导入')} onClose=${busy ? undefined : onClose} width="9.4rem" actions=${actions}>
    <div class="st-step">
      <p class="st-note">${t('选择一个 Forge 工坊包（zip 或文件夹）。先预览报告，确认后才写入 plugins/。')}</p>
      <label class="st-forge-file">${t('从 Forge 包导入')} zip
        <input ref=${zipRef} type="file" accept=".zip,application/zip" data-testid="forge-zip" disabled=${busy}
          onChange=${(e) => { const f = e.currentTarget.files?.[0]; if (dirRef.current) dirRef.current.value = ''; takeZip(f); }} />
      </label>
      <label class="st-forge-file">${t('从 Forge 包导入')}
        <input ref=${dirRef} type="file" webkitdirectory=${true} directory=${true} multiple=${true} data-testid="forge-folder" disabled=${busy}
          onChange=${(e) => { if (zipRef.current) zipRef.current.value = ''; takeDir(e.currentTarget.files || []); }} />
      </label>
      ${note ? html`<p class="st-note">${note}</p>` : null}
      ${error ? html`<p class="st-error" role="alert">${error}</p>` : null}
      ${report && !report.products?.length ? html`<p class="st-note">${t('这个包没有可以写入的插件。')}</p>` : null}
      ${report ? html`<div>
        <h3 class="st-note">${t('导入报告')}</h3>
        <pre class="st-forge-report" data-testid="forge-report">${report.markdown || ''}</pre>
      </div>` : null}
    </div>
  </${Modal}>`;
}
