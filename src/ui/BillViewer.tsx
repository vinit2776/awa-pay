"use client";

import { useState } from "react";
import { buttonClass, eyebrowClass } from "./styles";

export type BillPage = { id: string; pageNo: number; mime: string; downloadUrl: string };

// Every desk checks the same paper, so the bill is shown, not linked.
// URLs are presigned and expire; nothing here caches them.
export function BillViewer({ pages }: { pages: BillPage[] }) {
  const [index, setIndex] = useState(0);
  if (pages.length === 0) {
    return <p className="rounded-xl border border-line-soft bg-sunk p-4 text-sm text-ink-2">No bill was attached to this request.</p>;
  }

  const page = pages[Math.min(index, pages.length - 1)];
  const isPdf = page.mime === "application/pdf";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2">
        <span className={eyebrowClass}>
          Bill · page {page.pageNo} of {pages.length}
        </span>
        <a href={page.downloadUrl} target="_blank" rel="noreferrer" className="text-[12.5px] font-medium text-accent hover:underline">
          Open full size ↗
        </a>
      </div>

      {isPdf ? (
        <div className="flex min-h-56 flex-col items-center justify-center gap-3 rounded-xl border border-line bg-surface p-6 text-center">
          <p className="text-sm text-ink-2">Page {page.pageNo} is a PDF.</p>
          <a href={page.downloadUrl} target="_blank" rel="noreferrer" className={buttonClass("secondary", "sm")}>
            Open the PDF
          </a>
        </div>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- presigned R2 URL, deliberately not run through the image optimizer
        <img
          src={page.downloadUrl}
          alt={`Bill page ${page.pageNo}`}
          className="max-h-[32rem] w-full rounded-xl border border-line bg-surface object-contain"
        />
      )}

      {pages.length > 1 && (
        <ul className="flex flex-wrap gap-2">
          {pages.map((p, i) => (
            <li key={p.id}>
              <button
                type="button"
                onClick={() => setIndex(i)}
                aria-current={i === index ? "true" : undefined}
                className={`rounded-md border px-2.5 py-1 text-xs ${
                  i === index ? "border-accent bg-accent-soft font-semibold text-accent" : "border-line bg-surface text-ink-2 hover:border-accent"
                }`}
              >
                Page {p.pageNo}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
