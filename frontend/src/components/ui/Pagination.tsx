// Pagination: Previous / Next navigation for multi-page lists.
// The page-count display uses .teams-pagination from globals.css (layout class
// shared with the teams page). The buttons row uses .pagination-buttons.

import { Button } from "./Button";

interface PaginationProps {
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

export default function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <div className="teams-pagination">
      <span>
        Page {page} of {totalPages}
      </span>
      <div className="pagination-buttons">
        <Button
          variant="ghost"
          size="sm"
          disabled={page <= 1}
          onClick={() => onPageChange(Math.max(1, page - 1))}
        >
          Back
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={page >= totalPages}
          onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        >
          Next
        </Button>
      </div>
    </div>
  );
}
