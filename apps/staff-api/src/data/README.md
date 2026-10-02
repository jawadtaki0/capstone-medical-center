# Offline common-password dictionary

common-passwords.txt is a derived subset of SecLists' public common-password dictionary. It is security reference data, not staff/patient credentials or a credential export. It is never sent to the renderer or downloaded at runtime.

- Upstream: https://github.com/danielmiessler/SecLists
- Source: https://github.com/danielmiessler/SecLists/blob/bd8f9b5501f9257e9d39c733540e793602c3da6f/Passwords/Common-Credentials/xato-net-10-million-passwords-1000000.txt
- Pinned revision: bd8f9b5501f9257e9d39c733540e793602c3da6f
- Original source SHA-256: 424a3e03a17df0a2bc2b3ca749d81b04e79d59cb7aeec8876a5a3f308d0caf51
- License: MIT; the unmodified upstream notice is preserved in LICENSE.
- Derived entries: 10898, from the top 1,000,000 list.

Derivation retains source entries whose original length is 15–128 Unicode code points, applies NFKC/trim/lowercase only to comparison keys, removes duplicate/empty keys, sorts, and writes LF-separated text. Actual chosen passwords are never trimmed, normalized or truncated. The approved minimum-length rule rejects shorter chosen passwords separately. Comparison is whole-password equality, not a substring ban. Context checks for predictable complete username/center variants remain separate in validation.js.

This finite offline list does not detect every exposed or predictable password. Refreshing it is a reviewed source change: pin the new upstream revision, repeat the same derivation, preserve the license, record counts/hash, and run validation tests. No external password lookup or live sending is introduced.

common-short-passwords.txt additionally contains 99 distinct normalized entries from the same revision's top-100 file: https://github.com/danielmiessler/SecLists/blob/bd8f9b5501f9257e9d39c733540e793602c3da6f/Passwords/Common-Credentials/xato-net-10-million-passwords-100.txt . Its original SHA-256 is 3b9909eacc7322317399992a2d308b04be3ab903f06bfc935fc4c5796235531e. This small supplement is deliberately not length-filtered: it prevents surrounding spaces from making a common short password appear to meet the minimum length. Whole-password comparison still applies, and the actual password is preserved unchanged.
