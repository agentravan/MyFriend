"use client";
// Minimal, safe Markdown → React (no innerHTML): headings, bold, links, lists, tables, code blocks.
import { Fragment, ReactNode } from "react";

function inline(t: string, k = 0): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|(https?:\/\/[^\s)<]+))/g;
  let last = 0, m: RegExpExecArray | null;
  while ((m = re.exec(t))) {
    if (m.index > last) out.push(t.slice(last, m.index));
    if (m[2]) out.push(<b key={k++}>{m[2]}</b>);
    else if (m[3]) out.push(<code key={k++}>{m[3]}</code>);
    else if (m[4]) out.push(<a key={k++} href={m[5]} target="_blank" rel="noopener noreferrer">{m[4]}</a>);
    else if (m[6]) out.push(<a key={k++} href={m[6]} target="_blank" rel="noopener noreferrer">{m[6].replace(/^https?:\/\/(www\.)?/, "").slice(0, 48)}</a>);
    last = m.index + m[0].length;
  }
  if (last < t.length) out.push(t.slice(last));
  return out;
}

const cells = (l: string) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export default function Md({ text }: { text: string }) {
  const lines = text.replace(/\r/g, "").split("\n"), blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; ) {
    const l = lines[i];
    if (/^```/.test(l)) { const buf: string[] = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++;
      blocks.push(<pre key={i}>{buf.join("\n")}</pre>); continue; }
    if (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const head = cells(l); i += 2; const body: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) body.push(cells(lines[i++]));
      blocks.push(<div key={i} className="md-table"><table><thead><tr>{head.map((h, j) => <th key={j}>{inline(h)}</th>)}</tr></thead>
        <tbody>{body.map((r, a) => <tr key={a}>{head.map((_, j) => <td key={j}>{inline(r[j] ?? "")}</td>)}</tr>)}</tbody></table></div>); continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)$/);
    if (h) { const T = (`h${Math.min(h[1].length + 2, 6)}`) as "h3"; blocks.push(<T key={i}>{inline(h[2])}</T>); i++; continue; }
    if (/^\s*([-*•]|\d+[.)])\s+/.test(l)) { const ordered = /^\s*\d/.test(l), items: string[] = [];
      while (i < lines.length && /^\s*([-*•]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*•]|\d+[.)])\s+/, ""));
      const L = ordered ? "ol" : "ul"; blocks.push(<L key={i}>{items.map((x, j) => <li key={j}>{inline(x)}</li>)}</L>); continue; }
    if (!l.trim()) { i++; continue; }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|```|\s*([-*•]|\d+[.)])\s+|\s*\|)/.test(lines[i])) para.push(lines[i++]);
    if (!para.length) para.push(lines[i++]);
    blocks.push(<p key={i}>{para.map((x, j) => <Fragment key={j}>{j > 0 && <br />}{inline(x)}</Fragment>)}</p>);
  }
  return <div className="md">{blocks}</div>;
}
