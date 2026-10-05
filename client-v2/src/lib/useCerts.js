import { useCallback, useEffect, useMemo, useState } from 'react';
import { getCertTypes, getMemberCerts } from '../api.js';
import { heldIndex } from './certs.js';

// The certificate list and who holds what. Small, so it is simply loaded
// whole by whichever view needs it.
export default function useCerts() {
  const [types, setTypes] = useState([]);
  const [rows, setRows] = useState([]);

  const reload = useCallback(async () => {
    try {
      const [t, r] = await Promise.all([getCertTypes(), getMemberCerts()]);
      setTypes(t);
      setRows(r);
    } catch { /* the certificate features just stay empty */ }
  }, []);

  useEffect(() => { reload(); }, [reload]);

  const held = useMemo(() => heldIndex(rows), [rows]);
  return { types, held, reload };
}
