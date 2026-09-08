let active: { id: string; mention: string } | null = null;
export const setNativeFileDrag = (id: string, mention: string) => {
  active = { id, mention };
};
export const readNativeFileDrag = () => active;
export const clearNativeFileDrag = (id: string) => {
  if (active?.id === id) active = null;
};
