import { initModal, openModal, closeModal } from './modal.js';

// Reusable full-size image lightbox — currently wired only into record/
// playback's failure thumbnails (#185), but deliberately generic (just an
// <img> src) so the visual-regression panel can adopt it later instead of
// building its own. Same open/close convention as the other single-image/
// single-form overlays (notes.js, replay.js): detach the native view while
// open so the overlay actually paints above it, reattach on close.
export async function openImageOverlay(src) {
  document.getElementById('imageOverlayImg').src = src;
  await openModal('imageOverlay');
}

async function closeImageOverlay() {
  await closeModal('imageOverlay');
  document.getElementById('imageOverlayImg').src = '';
}

export function initImageOverlay() {
  initModal('imageOverlay', closeImageOverlay);
  document.getElementById('imageOverlayCloseBtn').onclick = () => closeImageOverlay();
}
