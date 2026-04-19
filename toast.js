// toast.js — Toast notification system

/**
 * Show a toast notification
 * @param {string} message - The message to display
 * @param {string} type - Type of toast: 'success', 'error', 'info', 'warning'
 * @param {number} duration - Duration in milliseconds (default: 3000)
 */
function showToast(message, type = 'info', duration = 3000) {
  // Create toast container if it doesn't exist
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  // Create toast element
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  
  // Add icon based on type
  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`,
    error: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>`,
    warning: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>`,
    info: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>`
  };
  
  toast.innerHTML = `
    <div class="toast-icon">${icons[type] || icons.info}</div>
    <div class="toast-message">${message}</div>
    <button class="toast-close" aria-label="Close">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>
    </button>
  `;

  // Add to container
  container.appendChild(toast);

  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('toast-show');
  });

  // Close button handler
  const closeBtn = toast.querySelector('.toast-close');
  const closeToast = () => {
    toast.classList.remove('toast-show');
    toast.classList.add('toast-hide');
    setTimeout(() => {
      if (toast.parentNode === container) {
        container.removeChild(toast);
      }
    }, 300);
  };
  
  closeBtn.addEventListener('click', closeToast);

  // Auto-dismiss after duration
  if (duration > 0) {
    setTimeout(closeToast, duration);
  }

  return toast;
}

// CSS styles - will be injected into pages that use toast
const toastStyles = `
  .toast-container {
    position: fixed;
    top: 16px;
    right: 16px;
    z-index: 10000;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 12px 16px;
    background: var(--surface, #1c1c22);
    border: 1px solid var(--border, #2a2a33);
    border-radius: var(--radius, 8px);
    color: var(--text, #f0f0f5);
    font-family: 'Syne', -apple-system, BlinkMacSystemFont, sans-serif;
    font-size: 13px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    min-width: 280px;
    max-width: 420px;
    pointer-events: auto;
    opacity: 0;
    transform: translateX(100px);
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .toast-show {
    opacity: 1;
    transform: translateX(0);
  }

  .toast-hide {
    opacity: 0;
    transform: translateX(100px);
  }

  .toast-icon {
    flex-shrink: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }

  .toast-message {
    flex: 1;
    font-family: 'JetBrains Mono', monospace;
    font-size: 11px;
    line-height: 1.5;
  }

  .toast-close {
    flex-shrink: 0;
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    color: var(--muted, #6b6b7a);
    display: flex;
    align-items: center;
    justify-content: center;
    opacity: 0.6;
    transition: opacity 0.2s;
  }

  .toast-close:hover {
    opacity: 1;
  }

  .toast-success {
    border-color: var(--success, #4ade80);
    background: linear-gradient(135deg, rgba(74, 222, 128, 0.08) 0%, var(--surface, #1c1c22) 100%);
  }

  .toast-success .toast-icon {
    color: var(--success, #4ade80);
  }

  .toast-error {
    border-color: var(--danger, #f87171);
    background: linear-gradient(135deg, rgba(248, 113, 113, 0.08) 0%, var(--surface, #1c1c22) 100%);
  }

  .toast-error .toast-icon {
    color: var(--danger, #f87171);
  }

  .toast-warning {
    border-color: var(--warning, #fbbf24);
    background: linear-gradient(135deg, rgba(251, 191, 36, 0.08) 0%, var(--surface, #1c1c22) 100%);
  }

  .toast-warning .toast-icon {
    color: var(--warning, #fbbf24);
  }

  .toast-info {
    border-color: var(--accent, #e8ff47);
    background: linear-gradient(135deg, rgba(232, 255, 71, 0.05) 0%, var(--surface, #1c1c22) 100%);
  }

  .toast-info .toast-icon {
    color: var(--accent, #e8ff47);
  }

  @media (max-width: 640px) {
    .toast-container {
      left: 16px;
      right: 16px;
    }

    .toast {
      width: 100%;
      min-width: initial;
    }
  }
`;

// Inject styles on first load
(function injectToastStyles() {
  if (typeof document !== 'undefined' && !document.getElementById('toast-styles')) {
    const style = document.createElement('style');
    style.id = 'toast-styles';
    style.textContent = toastStyles;
    document.head.appendChild(style);
  }
})();
