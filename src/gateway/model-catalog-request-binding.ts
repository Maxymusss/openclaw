const catalogBinding = Symbol("openclaw.modelCatalogRequestBinding");
type CatalogBoundChoice = { [catalogBinding]?: () => boolean };

/** Request-local evidence never becomes protocol data or mutates shared catalog rows. */
export function bindModelCatalogRequestBinding<T extends object>(
  choice: T,
  read: () => boolean,
): T {
  Object.defineProperty(choice, catalogBinding, { value: read });
  return choice;
}

export function modelCatalogRequestBindingSupported(choice: object): boolean {
  // SAFETY: only bindModelCatalogRequestBinding writes this private symbol, with the declared reader.
  return (choice as CatalogBoundChoice)[catalogBinding]?.() === true;
}
