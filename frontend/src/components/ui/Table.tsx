"use client";

// Typed column-definition table with sortable headers, accessible row links,
// and stacked two-line card mode under 900px.
// Geometry lives in .table-* classes in globals.css.
//
// Uncontrolled (internal sort, row links):
//   const cols: ColumnDef<Row>[] = [
//     { key: "title", header: "Title", sortable: true },
//     { key: "status", header: "Status", render: (r) => <StatusChip status={r.status} /> },
//   ];
//   <Table columns={cols} rows={rows} rowKey={(r) => r.id} rowHref={(r) => `/items/${r.id}`} />
//
// Controlled (server-side sort, modal-open rows):
//   <Table
//     columns={cols} rows={rows} rowKey={(r) => r.id}
//     sortKey={sort.col} sortDirection={sort.dir} onSortChange={handleSortChange}
//     onRowClick={(r) => openModal(r.id)}
//   />

import Link from "next/link";
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

type SortDir = "ascending" | "descending" | "none";

interface TableProps<T extends object> {
  columns: ColumnDef<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /**
   * When set, the title cell (first column) contains a real Next.js `<Link>`
   * and clicking the row delegates to it for full keyboard/pointer accessibility.
   */
  rowHref?: (row: T) => string;
  /**
   * When set, clicking the row calls this callback (e.g. to open a detail modal).
   * Takes priority over rowHref when both are provided.
   */
  onRowClick?: (row: T) => void;
  loading?: boolean;
  emptyLabel?: string;
  className?: string;
  /**
   * Optional HTML `id` to set on each `<tr>`. Useful for anchor-based
   * scrollIntoView (e.g. workflow transition highlight).
   */
  rowId?: (row: T) => string;
  /**
   * Optional extra CSS class(es) to add to each row's `<tr>`. Useful for
   * temporary highlight effects driven by parent state.
   */
  rowClassName?: (row: T) => string | undefined;
  /**
   * Optional compact sort control rendered above the stacked list on
   * mobile viewports (<900px). The element is wrapped in a
   * `.table-compact-sort` div which the CSS hides at desktop widths.
   * Pass a `<select>` or a custom control that calls `onSortChange`.
   */
  compactSort?: ReactNode;
  // ── Controlled sort ────────────────────────────────────────────
  // Provide all three together to bypass internal sort state entirely.
  /** Controlled sort column key. Pass null/undefined for "no sort". */
  sortKey?: string | null;
  /** Controlled sort direction. */
  sortDirection?: SortDir;
  /**
   * Called when a sortable header is clicked in controlled mode.
   * direction is the proposed next value (ascending when switching to a new
   * column; flipped when clicking the active column). The parent may override.
   */
  onSortChange?: (key: string, direction: "ascending" | "descending") => void;
}

export function Table<T extends object>({
  columns,
  rows,
  rowKey,
  rowHref,
  onRowClick,
  loading = false,
  emptyLabel = "No items found.",
  className,
  rowId,
  rowClassName,
  compactSort,
  sortKey: sortKeyProp,
  sortDirection: sortDirectionProp,
  onSortChange,
}: TableProps<T>) {
  const isControlled = onSortChange !== undefined;

  // Uncontrolled sort state (ignored when isControlled).
  const [internalSortKey, setInternalSortKey] = useState<string | null>(null);
  const [internalSortDir, setInternalSortDir] = useState<SortDir>("none");

  const effectiveSortKey = isControlled ? (sortKeyProp ?? null) : internalSortKey;
  const effectiveSortDir = isControlled ? (sortDirectionProp ?? "none") : internalSortDir;

  function handleSort(key: string) {
    if (isControlled) {
      let nextDir: "ascending" | "descending";
      if (effectiveSortKey === key) {
        nextDir = effectiveSortDir === "ascending" ? "descending" : "ascending";
      } else {
        nextDir = "ascending";
      }
      onSortChange!(key, nextDir);
    } else {
      if (internalSortKey === key) {
        if (internalSortDir === "ascending") {
          setInternalSortDir("descending");
        } else if (internalSortDir === "descending") {
          setInternalSortDir("none");
          setInternalSortKey(null);
        } else {
          setInternalSortDir("ascending");
        }
      } else {
        setInternalSortKey(key);
        setInternalSortDir("ascending");
      }
    }
  }

  const sortedRows =
    !isControlled && internalSortKey && internalSortDir !== "none"
      ? [...rows].sort((a, b) => {
          const rec = a as Record<string, unknown>;
          const rec2 = b as Record<string, unknown>;
          const aVal = String(rec[internalSortKey] ?? "");
          const bVal = String(rec2[internalSortKey] ?? "");
          const cmp = aVal.localeCompare(bVal, undefined, { numeric: true });
          return internalSortDir === "ascending" ? cmp : -cmp;
        })
      : rows;

  // When any column declares a width, switch to fixed table layout so the
  // declared widths are binding rather than treated as hints by the browser.
  // Tables with no declared widths keep the default auto layout.
  const hasWidths = columns.some((c) => Boolean(c.width));

  return (
    <div className={["table-wrapper", className].filter(Boolean).join(" ")}>
      {compactSort && (
        <div className="table-compact-sort">{compactSort}</div>
      )}
      <table className={["table", hasWidths ? "table--fixed" : ""].filter(Boolean).join(" ")}>
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
                aria-sort={col.sortable && effectiveSortKey === col.key ? effectiveSortDir : col.sortable ? "none" : undefined}
                data-col={col.key}
                // eslint-disable-next-line no-restricted-syntax
                style={col.width ? { width: col.width } : undefined /* dynamic: column width prop */}
              >
                {col.sortable ? (
                  <button
                    type="button"
                    className={["table-sort-btn", effectiveSortKey === col.key ? "table-sort-btn--active" : ""].filter(Boolean).join(" ")}
                    onClick={() => handleSort(col.key)}
                  >
                    {col.header}
                    <span
                      className={[
                        "table-sort-icon",
                        effectiveSortKey === col.key && effectiveSortDir === "ascending" ? "table-sort-icon--up" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      aria-hidden="true"
                    >
                      <Icon
                        name={effectiveSortKey === col.key && effectiveSortDir === "descending" ? "chevron-down" : "chevron-right"}
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
              // onRowClick takes priority; rowHref is suppressed when both are set.
              const href = !onRowClick ? rowHref?.(row) : undefined;
              const hasClick = onRowClick !== undefined || href !== undefined;
              const extraClass = rowClassName?.(row);
              return (
                <tr
                  key={rowKey(row)}
                  id={rowId?.(row)}
                  className={["table-tr", hasClick ? "table-tr--link" : "", extraClass].filter(Boolean).join(" ")}
                  onClick={
                    onRowClick
                      ? () => onRowClick(row)
                      : href
                      ? (e) => {
                          if ((e.target as HTMLElement).closest("a")) return;
                          const anchor = e.currentTarget.querySelector<HTMLAnchorElement>("a.table-row-link");
                          anchor?.click();
                        }
                      : undefined
                  }
                  tabIndex={hasClick ? 0 : undefined}
                  onKeyDown={
                    hasClick
                      ? (e) => {
                          if (e.key === "Enter" || (onRowClick && e.key === " ")) {
                            e.preventDefault();
                            if (onRowClick) {
                              onRowClick(row);
                            } else {
                              e.currentTarget.querySelector<HTMLAnchorElement>("a.table-row-link")?.click();
                            }
                          }
                        }
                      : undefined
                  }
                >
                  {columns.map((col, colIndex) => {
                    const isTitle = colIndex === 0;
                    const cell = col.render
                      ? col.render(row)
                      : ((row as unknown as Record<string, unknown>)[col.key] as ReactNode);
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
                          // Real <Link> lives in the title cell for full keyboard/SPA routing.
                          // tabIndex={-1} so tab order goes through the row, not twice.
                          <Link href={href} className="table-row-link" tabIndex={-1}>
                            {cell}
                          </Link>
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
