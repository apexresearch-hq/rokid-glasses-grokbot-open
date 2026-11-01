/**
 * Pure pagination: split body into pages by character count.
 * Prefer breaking near whitespace / Chinese punctuation when possible.
 * @param {string} text
 * @param {number} charsPerPage
 * @returns {string[]}
 */
function paginate(text, charsPerPage = 180) {
  const n = Math.max(1, Math.floor(Number(charsPerPage) || 180));
  const src = String(text ?? "");
  if (!src) return [""];

  const pages = [];
  let i = 0;
  while (i < src.length) {
    let end = Math.min(i + n, src.length);
    if (end < src.length) {
      const window = src.slice(i, end);
      // Prefer break after whitespace or CJK punctuation in last 40 chars
      const soft = window.search(/[\s。！？；，、：\n][^\s。！？；，、：\n]*$/);
      if (soft > Math.floor(n * 0.55)) {
        end = i + soft + 1;
      }
    }
    pages.push(src.slice(i, end));
    i = end;
  }
  return pages.length ? pages : [""];
}

/**
 * @param {string} text
 * @param {number} page 1-based
 * @param {number} charsPerPage
 * @returns {{ page: number, totalPages: number, text: string }}
 */
function getPage(text, page = 1, charsPerPage = 180) {
  const pages = paginate(text, charsPerPage);
  const totalPages = pages.length;
  let p = Math.floor(Number(page) || 1);
  if (p < 1) p = 1;
  if (p > totalPages) p = totalPages;
  return { page: p, totalPages, text: pages[p - 1] };
}

module.exports = { paginate, getPage };
