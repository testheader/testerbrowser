/* global testerBrowser */

// Reusable full-size image lightbox — currently wired only into record/
// playback's failure thumbnails (#185), but deliberately generic (just an
// <img> src) so the visual-regression panel can adopt it later instead of
// building its own. Same open/close convention as the other single-image/
// single-form overlays (notes.js, replay.js): detach the native view while
// open so the overlay actually paints above it, reattach on close.
export async function openImageOverlay(src) {
  document.getElementById('imageOverlayImg').src = src;
  await testerBrowser.layout.setViewerVisible(false);
  document.getElementById('imageOverlay').classList.add('open');
}

async function closeImageOverlay() {
  document.getElementById('imageOverlay').classList.remove('open');
  await testerBrowser.layout.setViewerVisible(true);
  document.getElementById('imageOverlayImg').src = '';
}

export function initImageOverlay() {
  document.getElementById('imageOverlayCloseBtn').onclick = () => closeImageOverlay();
  document.getElementById('imageOverlay').onclick = (e) => {
    if (e.target === document.getElementById('imageOverlay')) closeImageOverlay();
  };
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('imageOverlay').classList.contains('open')) closeImageOverlay();
  });
}
