/**
 * Thai 13-digit tax / citizen ID: the last digit is a mod-11 checksum of the first 12
 * (weights 13 … 2). Used to validate buyer and seller IDs on tax invoices.
 */
export function isValidThaiTaxId(raw: string): boolean {
  const d = raw.replace(/[\s-]/g, '')
  if (!/^\d{13}$/.test(d)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(d[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(d[12])
}

/** 0105556012345 → 0-1055-56012-34-5 */
export function formatTaxId(raw: string): string {
  const d = raw.replace(/\D/g, '')
  return d.length === 13 ? `${d[0]}-${d.slice(1, 5)}-${d.slice(5, 10)}-${d.slice(10, 12)}-${d[12]}` : raw
}

/** Branch code on tax invoices: "00000" = head office (สำนักงานใหญ่). */
export function isValidBranchNo(s: string): boolean {
  return /^\d{5}$/.test(s)
}
