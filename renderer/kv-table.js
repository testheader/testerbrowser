// #254: addKvRow/readKvTable were duplicated byte-for-byte (mod one missing
// `del.type = 'button'`, folded into this shared version) between mock.js
// and replay.js — both build the same "name/value pairs with a remove
// button" editor for headers/cookies. Kept in its own small file rather than
// utils.js, which otherwise holds only pure, non-DOM logic (see utils.d.ts) —
// same reasoning as session-picker.js.

// Appends one editable key/value row (with a remove button) to `container`.
export function addKvRow(container, key, val) {
  const row = document.createElement('div');
  row.className = 'kv-row';
  const kInput = document.createElement('input');
  kInput.className   = 'kv-key';
  kInput.type        = 'text';
  kInput.value       = key;
  kInput.placeholder = 'Name';
  const vInput = document.createElement('input');
  vInput.className   = 'kv-val';
  vInput.type        = 'text';
  vInput.value       = val;
  vInput.placeholder = 'Value';
  const del = document.createElement('button');
  del.className   = 'kv-del';
  del.type        = 'button'; // never submit an enclosing form
  del.textContent = '×';
  del.title       = 'Remove';
  del.onclick     = () => row.remove();
  row.appendChild(kInput);
  row.appendChild(vInput);
  row.appendChild(del);
  container.appendChild(row);
}

// Reads every `.kv-row` under `container` back into a plain object, skipping
// rows with an empty (or whitespace-only) key.
export function readKvTable(container) {
  const obj = {};
  for (const row of container.querySelectorAll('.kv-row')) {
    const k = row.querySelector('.kv-key').value.trim();
    const v = row.querySelector('.kv-val').value;
    if (k) obj[k] = v;
  }
  return obj;
}
