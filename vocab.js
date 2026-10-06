// Canonical spellings for the enumerable fields, shared by every write path
// (server.js sanitizeYoyo) and the boot-time cleanup in db.js.
//
// Condition: "NMTBS" is Near Mint To Be Safe. "NMBTS" was a long-standing
// misspelling baked into old CSVs, backups and app data; it is translated on
// every write so it can never come back.
// Composition: MN / BI / TRI mean mono-, bi- and tri-MATERIAL (a one-piece
// plastic is MN), so the old free-text "Plastic" maps to MN.
export function canonicalCondition(v) {
  const t = String(v ?? '').trim();
  return /^nmbts$/i.test(t) || /^nmtbs$/i.test(t) ? 'NMTBS' : t;
}
export function canonicalComposition(v) {
  const t = String(v ?? '').trim();
  if (/^(mn|bi|tri)$/i.test(t)) return t.toUpperCase();
  if (/^(plastic|mono[- ]?(material|metal))$/i.test(t)) return 'MN';
  if (/^bi[- ]?(material|metal)$/i.test(t)) return 'BI';
  if (/^tri[- ]?(material|metal)$/i.test(t)) return 'TRI';
  return t;
}
