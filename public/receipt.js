// Public, shareable payment receipt. The page never receives a wallet address: its data comes only
// from the same display-safe receipt endpoint the payer flow uses.
(() => {
  const id = document.body?.dataset.receiptId;
  const title = document.querySelector('#receiptTitle');
  const copy = document.querySelector('#receiptCopy');
  const details = document.querySelector('#receiptDetails');
  const copyButton = document.querySelector('#copyReceiptLink');
  if (!/^[0-9a-f-]{36}$/i.test(String(id || ''))) return;

  function addDetail(label, value) {
    const row = document.createElement('div');
    const labelNode = document.createElement('span');
    const valueNode = document.createElement('b');
    labelNode.textContent = label;
    valueNode.textContent = value;
    row.append(labelNode, valueNode);
    details.appendChild(row);
  }
  async function copyLink() {
    const link = window.location.href;
    try { await navigator.clipboard?.writeText?.(link); } catch { /* Show the URL below if clipboard access is unavailable. */ }
    copy.textContent = link;
  }
  async function load() {
    try {
      const response = await fetch(`/api/payments/${encodeURIComponent(id)}`);
      const receipt = await response.json();
      if (!response.ok) throw new Error('NOT_FOUND');
      const settled = receipt.status === 'settled' && receipt.settlementVerified === true;
      const failed = receipt.final && !settled;
      title.textContent = settled ? 'Payment complete.' : failed ? 'Payment update.' : 'Payment in progress.';
      copy.textContent = settled
        ? 'The exact payment has been confirmed.'
        : failed ? (receipt.failure?.message || 'This payment was not completed.')
          : 'Handoff is still confirming this payment. Refresh this page for the latest update.';
      details.textContent = '';
      if (receipt.recipient?.username) addDetail('Paid to', `@${receipt.recipient.username}`);
      if (receipt.receive?.requested) addDetail('Amount requested', `$${receipt.receive.requested}`);
      if (settled && receipt.receive?.amount) addDetail('Amount confirmed', `$${receipt.receive.amount}`);
      addDetail('Status', receipt.label || 'Updating');
      details.hidden = false;
      copyButton.hidden = false;
    } catch {
      title.textContent = 'Receipt unavailable.';
      copy.textContent = 'This receipt link may be invalid, or its latest update is temporarily unavailable.';
    }
  }
  copyButton.addEventListener('click', copyLink);
  load();
})();
