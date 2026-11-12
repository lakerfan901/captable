import {
  columnFacetingFeature,
  columnFilteringFeature,
  columnVisibilityFeature,
  createFacetedRowModel,
  createFacetedUniqueValues,
  createFilteredRowModel,
  createPaginatedRowModel,
  createSortedRowModel,
  filterFns,
  rowPaginationFeature,
  rowSelectionFeature,
  rowSortingFeature,
  sortFns,
  tableFeatures,
} from "@tanstack/react-table";

/**
 * TanStack Table v9 features shared by every data table in the app: the
 * column filtering/faceting, visibility, sorting, pagination and row
 * selection that v8 bundled by default, plus their client-side row models.
 */
export const dataTableFeatures = tableFeatures({
  columnFilteringFeature,
  columnFacetingFeature,
  columnVisibilityFeature,
  rowSortingFeature,
  rowPaginationFeature,
  rowSelectionFeature,
  filteredRowModel: createFilteredRowModel(),
  sortedRowModel: createSortedRowModel(),
  paginatedRowModel: createPaginatedRowModel(),
  facetedRowModel: createFacetedRowModel(),
  facetedUniqueValues: createFacetedUniqueValues(),
  filterFns,
  sortFns,
});

export type DataTableFeatures = typeof dataTableFeatures;
