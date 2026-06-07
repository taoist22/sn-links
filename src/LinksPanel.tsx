import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import {
  FileUtils,
  PluginCommAPI,
  PluginFileAPI,
  PluginManager,
  PluginNoteAPI,
  RattaFileSelector,
} from 'sn-plugin-lib';
import {subscribeToButtonEvents} from './pluginRouter';

// ─── Constants ─────────────────────────────────────────────────────────────────

const ELEMENT_TYPE_LINK = 600;
const SWEEP_STOP_AFTER_MISSES = 2;
const SWEEP_HARD_CAP = 60;

// Device-native insert px (links/text place in device-native coords).
const NATIVE = {
  manta: {w: 1920, h: 2560},
  nomad: {w: 1404, h: 1872},
};

// Links-index layout
const IDX_LEFT = 100;
const IDX_TOP = 200;
const IDX_ROW_H = 90;
const IDX_HEAD_H = 65;
const IDX_FONT = 30;
const IDX_LINK_H = 60;

// Index grouping order (#4)
const GROUPS: {label: string; types: number[]}[] = [
  {label: 'NOTES', types: [0, 1]},
  {label: 'DOCUMENTS', types: [2]},
  {label: 'WEB', types: [4]},
  {label: 'IMAGES', types: [3]},
];

// ─── Types ───────────────────────────────────────────────────────────────────

type LinkRow = {
  page: number;
  linkType: number;
  destPath: string;
  destPage: number;
  broken: boolean;
};

type Mode = 'index' | 'web' | 'file';
type Pos = 'TL' | 'TR' | 'BL' | 'BR';

// ─── Helpers ───────────────────────────────────────────────────────────────────

function destLabel(linkType: number, destPath: string, destPage: number): string {
  const base = (destPath.split('/').pop() ?? destPath).replace(
    /\.(note|pdf|epub|png|jpg|jpeg)$/i,
    '',
  );
  if (linkType === 4) {
    return destPath;
  }
  if (linkType === 0 && destPage >= 0) {
    return `${base} (p.${destPage + 1})`;
  }
  return base || destPath || '(no destination)';
}

function domainOf(url: string): string {
  return url
    .replace(/^https?:\/\//i, '')
    .replace(/^www\./i, '')
    .replace(/\/.*$/, '')
    .trim();
}

function getLinkTypeForPath(path: string): number {
  const ext = path.toLowerCase().split('.').pop();
  if (ext === 'note') return 0;
  if (ext === 'pdf' || ext === 'epub') return 2;
  if (ext === 'png' || ext === 'jpg' || ext === 'jpeg' || ext === 'webp') return 3;
  return 2; // fallback to document
}

function estimateWidth(text: string, font: number, maxW: number): number {
  const w = Math.ceil(text.length * font * 0.62) + 50;
  return Math.max(140, Math.min(w, maxW - 120));
}

function groupKeyOf(linkType: number): number {
  for (let g = 0; g < GROUPS.length; g++) {
    if (GROUPS[g].types.includes(linkType)) {
      return g;
    }
  }
  return GROUPS.length; // "OTHER"
}

// FileUtils.exists can be slow/hang in the sandbox — never let it block the read.
async function existsSafe(path: string): Promise<boolean | null> {
  try {
    const res = (await Promise.race([
      FileUtils.exists(path),
      new Promise((_, rej) => setTimeout(() => rej(new Error('t')), 2500)),
    ])) as any;
    const ok = typeof res === 'boolean' ? res : res?.result;
    return typeof ok === 'boolean' ? ok : null;
  } catch {
    return null; // unknown — treat as not-broken
  }
}

// ─── Component ───────────────────────────────────────────────────────────────

export default function LinksPanel() {
  const [mode, setMode] = useState<Mode>('index');
  const [links, setLinks] = useState<LinkRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [isManta, setIsManta] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [busy, setBusy] = useState(false);

  const [url, setUrl] = useState('https://www.google.com');
  const [webLabel, setWebLabel] = useState('');
  
  const [filePath, setFilePath] = useState('');
  const [fileLabel, setFileLabel] = useState('');
  const [destPageStr, setDestPageStr] = useState('1');
  const [totalPages, setTotalPages] = useState(0);

  const [pos, setPos] = useState<Pos>('TL');

  const filePathRef = useRef<string>('(unknown)');

  // ── Read all links + flag broken targets (#3) ──────────────────────────────
  const readLinks = useCallback(async () => {
    setLoading(true);
    setStatus('');
    const found: LinkRow[] = [];
    try {
      const dt = (await PluginManager.getDeviceType()) as any;
      const dtVal = typeof dt === 'number' ? dt : dt?.result;
      setIsManta(dtVal === 5 || dtVal === '5');
    } catch {
      // default nomad sizing
    }

    let filePath = '(unknown)';
    try {
      const pathRes = (await PluginCommAPI.getCurrentFilePath()) as any;
      if (pathRes?.success && typeof pathRes.result === 'string') {
        filePath = pathRes.result;
      }
    } catch {
      // handled below
    }
    filePathRef.current = filePath;

    try {
      await PluginNoteAPI.saveCurrentNote();
    } catch {
      // best-effort flush
    }

    if (filePath !== '(unknown)') {
      let misses = 0;
      for (let page = 0; page < SWEEP_HARD_CAP; page++) {
        let valid = false;
        try {
          const res = (await PluginFileAPI.getElements(page, filePath)) as any;
          if (res?.success && Array.isArray(res.result)) {
            valid = true;
            for (const el of res.result) {
              if (el?.type === ELEMENT_TYPE_LINK && el.link) {
                const l = el.link;
                found.push({
                  page,
                  linkType: l.linkType ?? -1,
                  destPath: l.destPath ?? '',
                  destPage: l.destPage ?? -1,
                  broken: false,
                });
              }
              try {
                await el.recycle?.();
              } catch {
                // best-effort
              }
            }
          }
        } catch {
          // treat as miss
        }
        if (valid) {
          misses = 0;
        } else if (++misses >= SWEEP_STOP_AFTER_MISSES) {
          break;
        }
      }
    }

    // De-dupe by destination.
    const seen = new Set<string>();
    const deduped = found.filter(l => {
      const key = `${l.linkType}|${l.destPath}|${l.destPage}`;
      if (seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });

    // Broken check: file-based links whose target is missing (timeout-guarded).
    for (const l of deduped) {
      if ((l.linkType === 0 || l.linkType === 1 || l.linkType === 2) && l.destPath) {
        const ok = await existsSafe(l.destPath);
        l.broken = ok === false;
      }
    }

    setLinks(deduped);
    setLoading(false);
  }, []);

  // Initial read + re-read on every toolbar press (panel never unmounts).
  useEffect(() => {
    readLinks();
    const unsub = subscribeToButtonEvents(() => {
      setStatus('');
      setFilePath('');
      setFileLabel('');
      setDestPageStr('1');
      setTotalPages(0);
      readLinks();
    });
    return unsub;
  }, [readLinks]);

  // ── Generate the grouped links index on the current page (#1 layout, #4) ───
  const fillThisPage = useCallback(async () => {
    if (busy) {
      return;
    }
    if (links.length === 0) {
      setStatus('No links found in this note.');
      return;
    }
    setBusy(true);
    setStatus('Adding links…');

    const dev = isManta ? NATIVE.manta : NATIVE.nomad;
    const linkW = isManta ? 700 : 520;
    const maxY = dev.h - 80;

    const buckets: LinkRow[][] = Array.from({length: GROUPS.length + 1}, () => []);
    for (const l of links) {
      buckets[groupKeyOf(l.linkType)].push(l);
    }

    let y = IDX_TOP;
    let ok = 0;
    let failed = 0;
    let overflow = 0;

    for (let g = 0; g < buckets.length; g++) {
      const items = buckets[g];
      if (items.length === 0) {
        continue;
      }
      const label = g < GROUPS.length ? GROUPS[g].label : 'OTHER';

      if (y + 45 <= maxY) {
        try {
          await PluginNoteAPI.insertText({
            fontSize: 28,
            textContentFull: label,
            textBold: 1,
            textRect: {left: IDX_LEFT, top: y, right: IDX_LEFT + linkW, bottom: y + 45},
          } as any);
        } catch {
          // header is cosmetic; ignore failure
        }
        y += IDX_HEAD_H;
      }

      for (const l of items) {
        if (y + IDX_LINK_H > maxY) {
          overflow++;
          continue;
        }
        let label2 = destLabel(l.linkType, l.destPath, l.destPage);
        if (l.broken) {
          label2 += ' (missing)';
        }
        try {
          const res = (await PluginNoteAPI.insertTextLink({
            category: 0,
            linkType: l.linkType,
            destPath: l.destPath,
            destPage: l.destPage >= 0 ? l.destPage : 0,
            style: 0,
            rect: {left: IDX_LEFT, top: y, right: IDX_LEFT + linkW, bottom: y + IDX_LINK_H},
            fontSize: IDX_FONT,
            fullText: label2,
            showText: label2,
            isItalic: 0,
          } as any)) as any;
          if (res?.success) {
            ok++;
          } else {
            failed++;
          }
        } catch {
          failed++;
        }
        y += IDX_ROW_H;
      }
      y += 12;
    }

    try {
      await PluginNoteAPI.saveCurrentNote();
    } catch {
      // best-effort
    }

    let msg = `Added ${ok} link${ok === 1 ? '' : 's'}.`;
    if (failed > 0) {
      msg += ` ${failed} failed.`;
    }
    if (overflow > 0) {
      msg += ` ${overflow} didn't fit — add another page and run again.`;
    }
    msg += ' Close to view.';
    setStatus(msg);
    setBusy(false);
  }, [busy, links, isManta]);

  // ── Insert a web link on the current page ──────────────────────────────────
  const insertWebLink = useCallback(async () => {
    if (busy) {
      return;
    }
    const cleanUrl = url.trim();
    if (!cleanUrl) {
      setStatus('Enter a URL first.');
      return;
    }
    setBusy(true);
    const label = (webLabel.trim() || domainOf(cleanUrl) || cleanUrl).trim();
    const dev = isManta ? NATIVE.manta : NATIVE.nomad;
    const width = estimateWidth(label, IDX_FONT, dev.w);
    const top = pos.startsWith('B') ? dev.h - 220 - IDX_LINK_H : 220;
    const left = pos.endsWith('R') ? dev.w - width - 150 : 220;
    try {
      const res = (await PluginNoteAPI.insertTextLink({
        category: 0,
        linkType: 4,
        destPath: cleanUrl,
        destPage: 0,
        style: 0,
        rect: {left, top, right: left + width, bottom: top + IDX_LINK_H},
        fontSize: IDX_FONT,
        fullText: label,
        showText: label,
        isItalic: 0,
      } as any)) as any;
      if (res?.success) {
        try {
          await PluginNoteAPI.saveCurrentNote();
        } catch {
          // best-effort
        }
        setStatus(`Added "${label}". Close to view, then tap it.`);
      } else {
        setStatus('Web link failed: ' + (res?.error?.message ?? 'unknown'));
      }
    } catch (e) {
      setStatus('Web link error: ' + String(e));
    }
    setBusy(false);
  }, [busy, url, webLabel, pos, isManta]);

  // ── Repair broken link ──────────────────────────────────────────────────────
  const repairLink = async (l: LinkRow) => {
    if (busy) return;
    setBusy(true);
    setStatus(`Repairing link to ${l.destPath.split('/').pop()}...`);
    try {
      const result = await RattaFileSelector.selectFile({ selectType: 1 });
      if (result && result.length > 0) {
        const newPath = result[0];
        const newLinkType = getLinkTypeForPath(newPath);
        
        const res = (await PluginFileAPI.getElements(l.page, filePathRef.current)) as any;
        if (res?.success && Array.isArray(res.result)) {
          let modified = false;
          for (const el of res.result) {
            if (el?.type === ELEMENT_TYPE_LINK && el.link) {
              if (el.link.destPath === l.destPath && el.link.destPage === l.destPage) {
                el.link.destPath = newPath;
                el.link.linkType = newLinkType;
                
                const modRes = (await PluginFileAPI.modifyElements(filePathRef.current, l.page, [el])) as any;
                if (modRes?.success) {
                  modified = true;
                }
                try { await el.recycle?.(); } catch {}
                break;
              }
            }
            try { await el.recycle?.(); } catch {}
          }
          if (modified) {
            setStatus('Link repaired successfully.');
            readLinks();
          } else {
            setStatus('Could not find the original link element to modify.');
          }
        } else {
          setStatus('Failed to read page elements.');
        }
      } else {
        setStatus('');
      }
    } catch (e) {
      setStatus('Repair error: ' + String(e));
    }
    setBusy(false);
  };

  // ── Delete broken link ──────────────────────────────────────────────────────
  const deleteLink = async (l: LinkRow) => {
    if (busy) return;
    setBusy(true);
    setStatus('Deleting link...');
    try {
      const res = (await PluginFileAPI.getElements(l.page, filePathRef.current)) as any;
      if (res?.success && Array.isArray(res.result)) {
        let deleted = false;
        for (const el of res.result) {
          if (el?.type === ELEMENT_TYPE_LINK && el.link) {
            if (el.link.destPath === l.destPath && el.link.destPage === l.destPage) {
              const delRes = (await PluginFileAPI.deleteElements(filePathRef.current, l.page, [el.numInPage])) as any;
              if (delRes?.success) {
                deleted = true;
              }
              try { await el.recycle?.(); } catch {}
              break;
            }
          }
          try { await el.recycle?.(); } catch {}
        }
        if (deleted) {
          setStatus('Link deleted successfully.');
          readLinks();
        } else {
          setStatus('Could not find the link element to delete.');
        }
      } else {
        setStatus('Failed to read page elements.');
      }
    } catch (e) {
      setStatus('Delete error: ' + String(e));
    }
    setBusy(false);
  };

  // ── Insert a file link on the current page ──────────────────────────────────
  const pickFile = async () => {
    try {
      const result = await RattaFileSelector.selectFile({ selectType: 1 });
      if (result && result.length > 0) {
        const selected = result[0];
        setFilePath(selected);
        const name = selected.split('/').pop()?.replace(/\.[^/.]+$/, '') || '';
        if (!fileLabel) setFileLabel(name);
        
        if (selected.endsWith('.note')) {
          try {
            const res = (await PluginFileAPI.getNoteTotalPageNum(selected)) as any;
            if (res?.success && typeof res.result === 'number') {
              setTotalPages(res.result);
            } else {
              setTotalPages(0);
            }
          } catch {
            setTotalPages(0);
          }
        } else {
          setTotalPages(0);
        }
      }
    } catch (e) {
      setStatus('File selection error: ' + String(e));
    }
  };

  const insertFileLink = useCallback(async () => {
    if (busy) {
      return;
    }
    if (!filePath) {
      setStatus('Select a file first.');
      return;
    }
    setBusy(true);
    const label = (fileLabel.trim() || filePath.split('/').pop() || filePath).trim();
    const dev = isManta ? NATIVE.manta : NATIVE.nomad;
    const width = estimateWidth(label, IDX_FONT, dev.w);
    const top = pos.startsWith('B') ? dev.h - 220 - IDX_LINK_H : 220;
    const left = pos.endsWith('R') ? dev.w - width - 150 : 220;
    let baseLinkType = getLinkTypeForPath(filePath);
    
    const parsedPage = parseInt(destPageStr, 10);
    const hasSpecificPage = !isNaN(parsedPage) && parsedPage > 0;
    const validPage = hasSpecificPage ? parsedPage - 1 : -1;
    
    if (baseLinkType === 0 && !hasSpecificPage) {
      baseLinkType = 1; // Link to whole file if no page specified
    }
    
    let finalPath = filePath;
    if (!finalPath.startsWith('/storage/emulated/0/')) {
      if (finalPath.startsWith('storage/emulated/0/')) {
        finalPath = '/' + finalPath;
      } else if (finalPath.startsWith('/')) {
        finalPath = '/storage/emulated/0' + finalPath;
      } else {
        finalPath = '/storage/emulated/0/' + finalPath;
      }
    }

    try {
      const res = (await PluginNoteAPI.insertTextLink({
        category: 0,
        linkType: baseLinkType,
        destPath: finalPath,
        destPage: validPage >= 0 ? validPage : 0,
        style: 0,
        rect: {left, top, right: left + width, bottom: top + IDX_LINK_H},
        fontSize: IDX_FONT,
        fullText: label,
        showText: label,
        isItalic: 0,
      } as any)) as any;
      if (res?.success) {
        try {
          await PluginNoteAPI.saveCurrentNote();
        } catch {
          // best-effort
        }
        setStatus(`Added file link "${label}".`);
      } else {
        setStatus('File link failed: ' + (res?.error?.message ?? 'unknown'));
      }
    } catch (e) {
      setStatus('File link error: ' + String(e));
    }
    setBusy(false);
  }, [busy, filePath, fileLabel, pos, isManta, destPageStr]);

  const handleClose = useCallback(() => {
    PluginManager.closePluginView();
  }, []);

  const brokenCount = links.filter(l => l.broken).length;

  // ─── Render ──────────────────────────────────────────────────────────────
  return (
    <Pressable style={styles.overlay} onPress={handleClose}>
      <Pressable style={styles.panel} onPress={e => e.stopPropagation()}>
        <View style={styles.header}>
          <Text style={styles.title}>Links</Text>
          <Pressable onPress={handleClose} style={styles.closeBtn}>
            <Text style={styles.closeText}>{'✕'}</Text>
          </Pressable>
        </View>

        <View style={styles.segment}>
          <SegBtn label="Links page" active={mode === 'index'} onPress={() => setMode('index')} />
          <SegBtn label="Web link" active={mode === 'web'} onPress={() => setMode('web')} />
          <SegBtn label="File link" active={mode === 'file'} onPress={() => setMode('file')} />
        </View>
        <View style={styles.divider} />

        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={true}
          persistentScrollbar={true}>
          {mode === 'index' ? (
            <>
              <Text style={styles.hint}>
                Add a blank page where you want the index, go to it, then tap
                Insert Links. Entries are grouped by type.
              </Text>

              {loading ? (
                <Text style={styles.muted}>Reading links…</Text>
              ) : links.length === 0 ? (
                <Text style={styles.muted}>No links found in this note.</Text>
              ) : (
                <View style={styles.previewBox}>
                  <Text style={styles.previewHead}>
                    {`${links.length} link${links.length === 1 ? '' : 's'} found`}
                  </Text>
                  <Text style={brokenCount > 0 ? styles.brokenLine : styles.okLine}>
                    {brokenCount > 0
                      ? `⚠ ${brokenCount} point to missing files`
                      : '✓ all targets resolve'}
                  </Text>
                  {links.slice(0, 8).map((l, i) => (
                    <View key={i} style={styles.previewItemRow}>
                      <Text style={[styles.previewItem, {flex: 1}]} numberOfLines={1}>
                        {`• ${destLabel(l.linkType, l.destPath, l.destPage)}${
                          l.broken ? '  ⚠ missing' : ''
                        }`}
                      </Text>
                      {l.broken && (
                        <View style={{flexDirection: 'row', gap: 4, alignItems: 'center'}}>
                          <Pressable onPress={() => repairLink(l)} disabled={busy} style={({pressed}) => [styles.repairBtn, pressed && styles.repairBtnPressed]}>
                            <Text style={styles.repairBtnText}>Repair</Text>
                          </Pressable>
                          <Pressable onPress={() => deleteLink(l)} disabled={busy} style={({pressed}) => [styles.deleteBtn, pressed && styles.repairBtnPressed]}>
                            <Text style={styles.deleteBtnText}>Delete</Text>
                          </Pressable>
                        </View>
                      )}
                    </View>
                  ))}
                  {links.length > 8 && (
                    <Text style={styles.previewItem}>{`…and ${links.length - 8} more`}</Text>
                  )}
                </View>
              )}

              <Pressable
                onPress={fillThisPage}
                disabled={busy || loading || links.length === 0}
                style={({pressed}) => [
                  styles.primaryBtn,
                  (busy || loading || links.length === 0) && styles.btnDisabled,
                  pressed && styles.primaryBtnPressed,
                ]}>
                <Text style={styles.primaryBtnText}>Insert Links</Text>
              </Pressable>
            </>
          ) : mode === 'web' ? (
            <>
              <Text style={styles.hint}>
                Drop a tappable link to a website on the current page.
              </Text>
              <TextInput
                style={styles.inputSm}
                value={url}
                onChangeText={setUrl}
                autoCapitalize="none"
                autoCorrect={false}
                placeholder="https://www.google.com"
              />
              <TextInput
                style={styles.inputSm}
                value={webLabel}
                onChangeText={setWebLabel}
                placeholder={domainOf(url) || 'label (optional)'}
              />
              <View style={{flexDirection: 'row', gap: 10, alignItems: 'center'}}>
                <Text style={styles.posLabel}>Position:</Text>
                <PosBtn label="TL" active={pos === 'TL'} onPress={() => setPos('TL')} />
                <PosBtn label="TR" active={pos === 'TR'} onPress={() => setPos('TR')} />
                <PosBtn label="BL" active={pos === 'BL'} onPress={() => setPos('BL')} />
                <PosBtn label="BR" active={pos === 'BR'} onPress={() => setPos('BR')} />
              </View>
              <Pressable
                onPress={insertWebLink}
                disabled={busy}
                style={({pressed}) => [
                  styles.smallBtn,
                  busy && styles.btnDisabled,
                  pressed && styles.smallBtnPressed,
                ]}>
                <Text style={styles.smallBtnText}>Insert web link</Text>
              </Pressable>
            </>
          ) : (
            <>
              <Text style={styles.hint}>
                Drop a tappable link to another file on the current page.
              </Text>
              <Pressable onPress={pickFile} style={styles.pickerBtn}>
                <Text style={styles.pickerBtnText} numberOfLines={1} ellipsizeMode="middle">
                  {filePath || 'Tap to select file...'}
                </Text>
              </Pressable>
              {filePath ? (
                <>
                  <TextInput
                    style={styles.inputSm}
                    value={fileLabel}
                    onChangeText={setFileLabel}
                    placeholder="label (optional)"
                  />
                  <TextInput
                    style={styles.inputSm}
                    value={destPageStr}
                    onChangeText={setDestPageStr}
                    placeholder={totalPages > 0 ? `Page number (1 - ${totalPages})` : "Page number (e.g. 1)"}
                    keyboardType="numeric"
                  />
                  {totalPages > 0 && (
                    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={styles.pageScroll}>
                      {Array.from({length: totalPages}).map((_, i) => (
                        <Pressable 
                          key={i} 
                          style={[styles.pageChip, destPageStr === String(i + 1) && styles.pageChipActive]}
                          onPress={() => setDestPageStr(String(i + 1))}
                        >
                          <Text style={[styles.pageChipText, destPageStr === String(i + 1) && styles.pageChipTextActive]}>
                            {i + 1}
                          </Text>
                        </Pressable>
                      ))}
                    </ScrollView>
                  )}
                  <View style={{flexDirection: 'row', alignItems: 'center', gap: 10}}>
                    <Text style={styles.posLabel}>Position:</Text>
                    <View style={{flexDirection: 'row', gap: 10}}>
                      <PosBtn label="TL" active={pos === 'TL'} onPress={() => setPos('TL')} />
                      <PosBtn label="TR" active={pos === 'TR'} onPress={() => setPos('TR')} />
                      <PosBtn label="BL" active={pos === 'BL'} onPress={() => setPos('BL')} />
                      <PosBtn label="BR" active={pos === 'BR'} onPress={() => setPos('BR')} />
                    </View>
                  </View>
                  <Pressable
                    onPress={insertFileLink}
                    disabled={busy}
                    style={({pressed}) => [
                      styles.smallBtn,
                      busy && styles.btnDisabled,
                      pressed && styles.smallBtnPressed,
                    ]}>
                    <Text style={styles.smallBtnText}>Insert file link</Text>
                  </Pressable>
                </>
              ) : null}
            </>
          )}

          {status !== '' && (
            <View style={styles.statusBox}>
              <Text style={styles.statusText}>{status}</Text>
            </View>
          )}
        </ScrollView>
      </Pressable>
    </Pressable>
  );
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function SegBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.segBtn, active && styles.segBtnActive]}>
      <Text style={[styles.segBtnText, active && styles.segBtnTextActive]}>{label}</Text>
    </Pressable>
  );
}

function PosBtn({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable onPress={onPress} style={[styles.posChip, active && styles.posChipActive]}>
      <Text style={[styles.posChipText, active && styles.posChipTextActive]}>{label}</Text>
    </Pressable>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

const styles = StyleSheet.create({
  overlay: {
    flex: 1,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'flex-start',
    paddingTop: 40,
  },
  panel: {
    width: 520,
    maxHeight: 1000,
    backgroundColor: '#FFFFFF',
    borderRadius: 12,
    borderWidth: 1.5,
    borderColor: '#000000',
  },
  header: {
    paddingHorizontal: 20,
    paddingVertical: 14,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  },
  title: {fontSize: 20, fontWeight: 'bold', color: '#000000'},
  closeBtn: {
    position: 'absolute',
    right: 20,
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 1.5,
    borderColor: '#000000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  closeText: {fontSize: 16, fontWeight: 'bold', color: '#000000'},
  divider: {height: 1, backgroundColor: '#000000', marginVertical: 4},
  segment: {flexDirection: 'row', gap: 8, paddingHorizontal: 20},
  segBtn: {
    flex: 1,
    borderWidth: 1.5,
    borderColor: '#000000',
    borderRadius: 8,
    paddingVertical: 10,
    alignItems: 'center',
  },
  segBtnActive: {backgroundColor: '#000000'},
  segBtnText: {fontSize: 14, fontWeight: '600', color: '#000000'},
  segBtnTextActive: {color: '#FFFFFF'},
  scroll: {maxHeight: 860},
  scrollContent: {paddingHorizontal: 20, paddingVertical: 12, gap: 8},
  hint: {fontSize: 12, color: '#666666', marginBottom: 4},
  muted: {fontSize: 13, color: '#888888', paddingVertical: 6},
  previewBox: {backgroundColor: '#F4F4F4', borderRadius: 8, padding: 10, gap: 2},
  previewHead: {fontSize: 13, fontWeight: '600', color: '#000000', marginBottom: 2},
  previewItem: {fontSize: 12, color: '#333333'},
  previewItemRow: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginVertical: 2},
  repairBtn: {backgroundColor: '#EEEEEE', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, marginLeft: 6, borderWidth: 1, borderColor: '#CCCCCC'},
  repairBtnPressed: {backgroundColor: '#DDDDDD'},
  repairBtnText: {fontSize: 10, color: '#333333', fontWeight: 'bold'},
  deleteBtn: {backgroundColor: '#FFF0F0', paddingHorizontal: 8, paddingVertical: 4, borderRadius: 4, marginLeft: 6, borderWidth: 1, borderColor: '#FFCCCC'},
  deleteBtnText: {fontSize: 10, color: '#B00000', fontWeight: 'bold'},
  okLine: {fontSize: 12, color: '#1A6B1A', marginBottom: 2},
  brokenLine: {fontSize: 12, color: '#B00000', fontWeight: '600', marginBottom: 2},
  primaryBtn: {
    backgroundColor: '#000000',
    borderRadius: 8,
    paddingVertical: 14,
    alignItems: 'center',
    marginTop: 8,
  },
  primaryBtnPressed: {backgroundColor: '#333333'},
  primaryBtnText: {fontSize: 16, fontWeight: 'bold', color: '#FFFFFF'},
  btnDisabled: {backgroundColor: '#BBBBBB'},
  inputSm: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 6,
    fontSize: 13,
    color: '#000000',
    marginTop: 6,
  },
  pageScroll: { marginTop: 6, marginBottom: 2, maxHeight: 40 },
  pageChip: { paddingHorizontal: 12, paddingVertical: 6, backgroundColor: '#EEEEEE', borderRadius: 16, marginRight: 6, borderWidth: 1, borderColor: '#CCCCCC' },
  pageChipActive: { backgroundColor: '#000000', borderColor: '#000000' },
  pageChipText: { fontSize: 12, color: '#333333' },
  pageChipTextActive: { color: '#FFFFFF' },
  pickerBtn: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 6,
    paddingHorizontal: 10,
    paddingVertical: 10,
    backgroundColor: '#F9F9F9',
  },
  pickerBtnText: {
    fontSize: 13,
    color: '#333333',
  },
  posRow: {flexDirection: 'row', gap: 8, marginTop: 6, alignItems: 'center'},
  posLabel: {fontSize: 12, color: '#888888', marginRight: 2},
  posChip: {
    borderWidth: 1,
    borderColor: '#999999',
    borderRadius: 14,
    paddingVertical: 4,
    paddingHorizontal: 12,
  },
  posChipActive: {backgroundColor: '#000000', borderColor: '#000000'},
  posChipText: {fontSize: 12, fontWeight: '600', color: '#333333'},
  posChipTextActive: {color: '#FFFFFF'},
  smallBtn: {
    alignSelf: 'flex-start',
    backgroundColor: '#000000',
    borderRadius: 6,
    paddingVertical: 8,
    paddingHorizontal: 18,
    marginTop: 8,
  },
  smallBtnPressed: {backgroundColor: '#333333'},
  smallBtnText: {fontSize: 13, fontWeight: '600', color: '#FFFFFF'},
  statusBox: {marginTop: 10, backgroundColor: '#EEF6EE', borderRadius: 8, padding: 10},
  statusText: {fontSize: 13, color: '#1A4D1A'},
});
