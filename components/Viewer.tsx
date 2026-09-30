"use client";
// On-screen deliverable viewer: tables are sortable/filterable with summary metrics, documents render as pages, apps run inline (sandboxed).
import { useEffect, useMemo, useState } from "react";
import Md from "@/components/Md";

export type FileMeta = { id: number; name: string; mime: string; size: number };

export function parseCsv(src: string): string[][] {
  const s = src.replace(/^﻿/, ""), rows: string[][] = [];
  let row: string[] = [], cell = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ",") { row.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cell); rows.push(row); row = []; cell = ""; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim()));
}

function Table({ rows }: { rows: string[][] }) {
  const [head, ...body] = rows;
  const [sort, setSort] = useState<{ c: number; d: 1 | -1 } | null>(null), [q, setQ] = useState("");
  const view = useMemo(() => {
    let r = q ? body.filter((x) => x.join(" ").toLowerCase().includes(q.toLowerCase())) : body;
    if (sort) r = [...r].sort((a, b) => {
      const x = a[sort.c] ?? "", y = b[sort.c] ?? "", nx = parseFloat(x.replace(/[₹,%\s]/g, "")), ny = parseFloat(y.replace(/[₹,%\s]/g, ""));
      return (!isNaN(nx) && !isNaN(ny) ? nx - ny : x.localeCompare(y)) * sort.d;
    });
    return r;
  }, [body, sort, q]);
  const filled = (re: RegExp) => { const c = head.findIndex((h) => re.test(h)); return c < 0 ? null : body.filter((r) => (r[c] ?? "").trim()).length; };
  const metrics: [string, string | number][] = [["Rows", body.length], ["Columns", head.length]];
  const add = (label: string, re: RegExp) => { const n = filled(re); if (n != null) metrics.push([label, `${n}/${body.length}`]); };
  add("With email", /e-?mail|email/i); add("With phone", /phone|mobile|contact no/i); add("With website", /website|url|site/i);
  const vc = head.findIndex((h) => /website check/i.test(h));
  if (vc >= 0) metrics.push(["Verified sites", body.filter((r) => (r[vc] ?? "").startsWith("✓")).length]);
  return <>
    <div className="vw-metrics">{metrics.map(([k, v]) => <div key={k}><small>{k}</small><b>{v}</b></div>)}</div>
    <input className="vw-filter" placeholder={`Filter ${body.length} rows…`} value={q} onChange={(e) => setQ(e.target.value)} />
    <div className="vw-table"><table><thead><tr><th>#</th>{head.map((h, i) =>
      <th key={i} onClick={() => setSort(sort?.c === i ? { c: i, d: sort.d === 1 ? -1 : 1 } : { c: i, d: 1 })}>{h}{sort?.c === i ? (sort.d === 1 ? " ▲" : " ▼") : ""}</th>)}</tr></thead>
      <tbody>{view.map((r, a) => <tr key={a}><td className="muted">{a + 1}</td>{head.map((_, i) => { const v = r[i] ?? "";
        return <td key={i} className={/^✓/.test(v) ? "up" : /^[✗⚠?]/.test(v) ? "warn" : ""}>{/^https?:\/\/|^www\./.test(v)
          ? <a href={v.startsWith("http") ? v : "https://" + v} target="_blank" rel="noopener noreferrer">{v.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}</a>
          : /^[\w.+-]+@[\w-]+\.[\w.]+$/.test(v) ? <a href={`mailto:${v}`}>{v}</a> : v}</td>; })}</tr>)}</tbody></table></div>
  </>;
}

export default function Viewer({ file, onClose }: { file: FileMeta; onClose: () => void }) {
  const [text, setText] = useState<string | null>(null), [err, setErr] = useState("");
  const isHtml = file.mime.includes("html"), isCsv = file.mime.includes("csv") || /\.csv$/i.test(file.name);
  useEffect(() => {
    if (isHtml) return;
    fetch(`/api/files/${file.id}`).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))).then(setText).catch((e) => setErr(e.message));
  }, [file.id, isHtml]);
  useEffect(() => { const k = (e: KeyboardEvent) => e.key === "Escape" && onClose(); addEventListener("keydown", k); return () => removeEventListener("keydown", k); }, [onClose]);
  return (
    <div className="scrim center" onClick={onClose}>
      <div className="viewer" onClick={(e) => e.stopPropagation()}>
        <div className="vw-h"><b title={file.name}>{file.name}</b>
          <span className="row"><a className="btn ghost" href={`/api/files/${file.id}`} target="_blank" rel="noopener">↗ New tab</a>
            <a className="btn ghost" href={`/api/files/${file.id}?dl=1`}>⤓ Save</a><button onClick={onClose}>✕</button></span></div>
        <div className="vw-body">
          {err && <p className="muted">Couldn’t load: {err}</p>}
          {isHtml ? <iframe src={`/api/files/${file.id}`} title={file.name} sandbox="allow-scripts allow-popups allow-forms allow-modals" />
            : text == null ? !err && <p className="muted">Loading…</p>
            : isCsv ? <Table rows={parseCsv(text)} />
            : <Md text={text} />}
        </div>
      </div>
    </div>
  );
}
