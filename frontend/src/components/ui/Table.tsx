"use client";

// Typed column-definition table with sortable headers, accessible row links,
// and stacked two-line card mode under 900px.
// Geometry lives in .table-* classes in globals.css.
//
// Usage:
//   const cols: ColumnDef<Task>[] = [
//     { key: "title", header: "Title", sortable: true },
//     { key: "status", header: "Status", render: (r) => <StatusChip status={r.status} /> },
//   ];
//   <Table columns={cols} rows={tasks} rowKey={(r) => r.id} rowHref={(r) => `/tasks/${r.id}`} />

import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface ColumnDef<T = Record<string, unknown>> {
  key: string;
  header: string;
  sortable?: boolean;
  /** Dynamic column width; kept as inline style since it is a prop value. */
  width?: string;
  align?: "left" | "center" | "right";
  render?: (row: T) => ReactNode;
}

interface TableProps<T extends Record<string, unknown>> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /**
   * When set, the title cell (first column) contains a real `<a>` link and
   * clicking the row delegates to it for full keyboard/pointer accessibility.
   */
  rowHref?: (row: T) => string;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
}

type SortDir = "ascending" | "descending" | "none";

export function Table<T extends Record<string, unknown>>({
  columns,
  rows,
  rowKey,
  rowHref,
  loading = false,
  emptyLabel = "No items found.",
  className,
}: TableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>("none");

  function handleSort(key: string) {
    if (sortKey === key) {
      if (sortDir === "ascending") {
        setSortDir("descending");
      } else if (sortDir === "descending") {
        setSortDir("none");
        setSortKey(null);
      } else {
        setSortDir("ascending");
      }
    } else {
      setSortKey(key);
      setSortDir("ascending");
    }
  }

  const sortedRows =
    sortKey && sortDir !== "none"
      ? [...rows].sort((a, b) => {
          const aVal = String(a[sortKey] ?? "");
          const bVal = String(b[sortKey] ?? "");
          const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
          return sortDir === "ascending" ? cmp : -cmp;
        })
      : rows;

  return (
    <div className={["table-wrapper", className].filter(Boolean).join(" ")}>
      <table className="table">
        <thead>
          <tr className="table-head-row">
            {columns.map((col) => (
              <th
                key={col.key}
                className={[
                  "table-th",
                  col.align === "right" ? "table-th--right" : col.align === "center" ? "table-th--center" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-sort={col.sortable && sortKey === col.key ? sortDir : col.sortable ? "none" : undefined}
                data-col={col.key}
                style={col.width ? { width: col.width } : undefined /* dynamic: column width prop */}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    className={["table-sort-btn", sortKey === col.key ? "table-sort-btn--active" : ""].filter(Boolean).join(" ")}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.header}
                    <span
                      className={[
                        "table-sort-icon",
                        sortKey === col.key && sortDir === "ascending" ? "table-sort-icon--up" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-hidden="true"
                    >
                      <Icon
                        name={sortKey === col.key && sortDir === "descending" ? "chevron-down" : "chevron-right"}
                        size={12}
                      />
                    </span>
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr className="table-tr table-tr--state">
              <td colSpan={columns.length} className="table-td table-td--state">
                <span className="spinner" aria-hidden="true" />
                <span className="sr-only">Loading</span>
              </td>
            </tr>
          ) : rows.length === 0 ? (
            <tr className="table-tr table-tr--state">
              <td colSpan={columns.length} className="table-td table-td--state">
                {emptyLabel}
              </td>
            </tr>
          ) : (
            sortedRows.map((row) => {
              const href = rowHref?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  className={["table-tr", href ? "table-tr--link" : ""].filter(Boolean).join(" ")}
                  onClick={
                    href
                      ? (e) => {
                          // Delegate to the real anchor if click is not on it
                          if ((e.target as HTMLElement).closest("a")) return;
                          const anchor = e.currentTarget.querySelector<HTMLAnchorElement>("a.table-row-link");
                          anchor?.click();
                        }
                      : undefined
                  }
                  tabIndex={href ? 0 : undefined}
                  onKeyDown={
                    href
                      ? (e) => {
                          if (e.key === "Enter") {
                            e.currentTarget.querySelector<HTMLAnchorElement>("a.table-row-link")?.click();
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((col, colIndex) => {
                    const isTitle = colIndex === 0;
                    const cell = col.render ? col.render(row) : (row[col.key] as ReactNode);
                    return (
                      <td
                        key={col.key}
                        className={[
                          "table-td",
                          col.align === "right" ? "table-td--right" : col.align === "center" ? "table-td--center" : "",
                        ]
                          .filter(Boolean)
                          .join(" ")}
                        data-col={col.key}
                        data-label={col.header}
                      >
                        {isTitle && href ? (
                          // Real <a> lives in title cell for full keyboard accessibility.
                          // tabIndex={-1} so tab order goes through the row, not twice.
                          <a href={href} className="table-row-link" tabIndex={-1}>
                            {cell}
                          </a>
                        ) : (
                          cell
                        )}
                      </td>
                    );
                  })}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}
