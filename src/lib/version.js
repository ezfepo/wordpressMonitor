/**
 * Minimal dotted-version comparator, PHP version_compare()-like: numeric
 * segments compared left to right, missing segments treated as 0.
 * Good enough for WordPress plugin/theme/core version strings.
 */

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) {
      return diff > 0 ? 1 : -1;
    }
  }
  return 0;
}

// Evaluates version `a` against `b` using one of WPVulnerability's lowercase
// operators (lt/le/eq/ne/gt/ge), which follow PHP version_compare() semantics.
function satisfiesOperator(a, operator, b) {
  const cmp = compareVersions(a, b);
  switch (operator) {
    case 'lt':
      return cmp < 0;
    case 'le':
      return cmp <= 0;
    case 'eq':
      return cmp === 0;
    case 'ne':
      return cmp !== 0;
    case 'gt':
      return cmp > 0;
    case 'ge':
      return cmp >= 0;
    default:
      return false;
  }
}

module.exports = { compareVersions, satisfiesOperator };
