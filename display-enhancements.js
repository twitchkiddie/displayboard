// Display Enhancements for Wall-Mounted Dashboard

let enhancementsConfig = {};

// Load config on startup
async function loadEnhancementsConfig() {
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        enhancementsConfig = cfg.display || {};
    } catch(e) {
        console.error('Failed to load enhancements config:', e);
        enhancementsConfig = {};
    }
}

// Hide cursor after 30 seconds of inactivity
let cursorTimeout;
function hideCursor() {
    document.body.style.cursor = 'none';
}

function showCursor() {
    document.body.style.cursor = 'default';
    clearTimeout(cursorTimeout);
    cursorTimeout = setTimeout(hideCursor, 30000);
}

document.addEventListener('mousemove', showCursor);
document.addEventListener('click', showCursor);

cursorTimeout = setTimeout(hideCursor, 30000);

// Auto-refresh page daily at configured hour
function scheduleDailyRefresh() {
    const refreshHour = enhancementsConfig.autoRefreshHour ?? 3;
    const now = new Date();
    const nextRefresh = new Date(now);
    nextRefresh.setHours(refreshHour, 0, 0, 0);
    
    if (now.getHours() >= refreshHour) {
        nextRefresh.setDate(nextRefresh.getDate() + 1);
    }
    
    const msUntilRefresh = nextRefresh - now;
    
    setTimeout(() => {
        window.location.reload();
    }, msUntilRefresh);
}

// Prevent screen burn-in: Subtle position shift at configured interval
let shiftOffset = 0;
function preventBurnIn() {
    if (enhancementsConfig.burnInEnabled === false) return;
    
    shiftOffset = (shiftOffset + 1) % 4;
    
    const shifts = [
        { x: 0, y: 0 },
        { x: 2, y: 0 },
        { x: 0, y: 2 },
        { x: -2, y: -2 }
    ];
    
    const shift = shifts[shiftOffset];
    document.body.style.transform = `translate(${shift.x}px, ${shift.y}px)`;
}

function startBurnInPrevention() {
    const interval = (enhancementsConfig.burnInInterval || 30) * 60 * 1000;
    if (enhancementsConfig.burnInEnabled !== false) {
        setInterval(preventBurnIn, interval);
    }
}

// Dim past events
function handlePastEvents() {
    const mode = enhancementsConfig.pastEventsMode || (enhancementsConfig.dimPastEvents ? 'dim' : 'show');
    const now = new Date();
    
    const todayColumn = document.querySelector('.calendar-column.today-column');
    if (todayColumn) {
        const events = todayColumn.querySelectorAll('.calendar-event:not(.all-day)');
        events.forEach(event => {
            const timeText = event.querySelector('.event-time');
            if (timeText) {
                const endTime = parseTime(timeText.textContent.split('–')[1]?.trim() || timeText.textContent.split('-')[1]?.trim());
                const isPast = endTime && endTime < now;
                event.classList.remove('past-event');
                event.style.display = '';
                if (isPast) {
                    if (mode === 'dim') event.classList.add('past-event');
                    else if (mode === 'hide') event.style.display = 'none';
                }
            }
        });
    }
}

// Parse time string like "5:30 PM" into Date object for today
function parseTime(timeStr) {
    if (!timeStr) return null;
    
    const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return null;
    
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const isPM = match[3].toUpperCase() === 'PM';
    
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    
    const now = new Date();
    const eventTime = new Date(now);
    eventTime.setHours(hours, minutes, 0, 0);
    
    return eventTime;
}

handlePastEvents();
setInterval(handlePastEvents, 60 * 1000);

// Error recovery: Reload if dashboard stops updating
let lastUpdateTime = Date.now();

function checkForStaleData() {
    const timeSinceUpdate = Date.now() - lastUpdateTime;
    const staleTimeout = (enhancementsConfig.staleTimeout || 30) * 60 * 1000;
    
    if (timeSinceUpdate > staleTimeout) {
        console.error(`Dashboard stale (${Math.round(timeSinceUpdate/60000)}min), reloading...`);
        window.location.reload();
    }
}

function startStaleDataCheck() {
    setInterval(checkForStaleData, 5 * 60 * 1000);
}

// Update timestamp when data refreshes
window.markDataRefresh = function() {
    lastUpdateTime = Date.now();
    const loader = document.getElementById('loading-indicator');
    if (loader) loader.style.display = 'none';
};

// Config/file change detection — auto-reload when files are updated
let knownVersion = null;

async function checkForConfigChanges() {
    try {
        const response = await fetch('/api/version');
        const data = await response.json();
        
        if (knownVersion === null) {
            knownVersion = data.version;
        } else if (data.version !== knownVersion) {
            window.location.reload();
        }
    } catch (error) {
        console.error('Version check failed:', error);
    }
}

checkForConfigChanges();
setInterval(checkForConfigChanges, 10000);

// Initialize all enhancements after loading config
async function initEnhancements() {
    await loadEnhancementsConfig();
    
    scheduleDailyRefresh();
    startBurnInPrevention();
    startStaleDataCheck();
}

// Start when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initEnhancements);
} else {
    initEnhancements();
}
