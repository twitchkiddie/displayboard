// Dashboard JavaScript
let currentPhotoIndex = 0;
let photos = [];
let currentTemp = '--';
let calendarColorMap = {};
let displayConfig = {};

// HTML escape function to prevent XSS
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#x27;');
}

// Update clock every second
function updateClock() {
    const now = new Date();
    
    const hours = now.getHours();
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    
    const timeEl = document.getElementById('time');
    timeEl.innerHTML = `${displayHours}:${minutes}<span class="seconds-small">:${seconds}</span>`;
    
    const options = { weekday: 'long', month: 'long', day: 'numeric' };
    const dateStr = now.toLocaleDateString('en-US', options);
    document.getElementById('date').textContent = dateStr;
}

// Update weather (current + forecast)
async function updateWeather() {
    try {
        const response = await fetch('/api/weather-extended');
        
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        
        const data = await response.json();
        
        if (data.error || !data.current || !data.forecast) {
            throw new Error(data.error || 'Invalid weather data structure');
        }
        
        // Current weather
        currentTemp = data.current.temp || '--';
        document.getElementById('current-temp').textContent = `${currentTemp}°`;
        document.getElementById('feels-like').textContent = `Feels like ${data.current.feelsLike || '--'}°`;
        
        // Wind & humidity line
        const windHumidity = [];
        if (data.current.wind) windHumidity.push('💨 ' + data.current.wind);
        if (data.current.humidity) windHumidity.push('💧 ' + data.current.humidity);
        const windHumidityEl = document.getElementById('wind-humidity');
        if (windHumidityEl) windHumidityEl.textContent = windHumidity.join('  ');
        
        // Sun/Moon
        document.getElementById('sunrise').textContent = data.current.sunrise || '--';
        document.getElementById('sunset').textContent = data.current.sunset || '--';
        document.getElementById('moon-phase').innerHTML = data.current.moonPhase || '--';
        
        const moonIconEl = document.querySelector('#sun-moon .moon-icon');
        if (moonIconEl && data.current.moonIcon) {
            moonIconEl.className = 'wi ' + data.current.moonIcon + ' moon-icon';
        }
        
        // 5-day forecast
        if (data.forecast && data.forecast.length >= 5) {
            for (let i = 0; i < 5; i++) {
                const day = data.forecast[i];
                const forecastEl = document.querySelector(`.forecast-day[data-day="${i}"]`);
                
                forecastEl.querySelector('.forecast-label').textContent = day.label;
                const wiClass = svgToWeatherIcon(day.icon);
                forecastEl.querySelector('.forecast-icon').innerHTML = `<i class="wi ${wiClass}"></i>`;
                forecastEl.querySelector('.forecast-precip').innerHTML = `<i class="wi wi-raindrop"></i> ${day.precip}%`;
                forecastEl.querySelector('.high').textContent = `${day.high}°`;
                forecastEl.querySelector('.low').textContent = `${day.low}°`;
            }
        }
        
        updateClock();
        
        if (window.markDataRefresh) window.markDataRefresh();
    } catch (error) {
        console.error('Weather fetch failed:', error);
        currentTemp = '--';
        document.getElementById('current-temp').textContent = '--°';
        document.getElementById('feels-like').textContent = 'Weather unavailable';
    }
}

// Update calendar (5 days, columnar layout)
let calendarLoaded = false;
async function updateCalendar() {
    try {
        const response = await fetch('/api/calendar?days=5');
        const data = await response.json();
        renderCalendar(data.events);
        // Apply past event hiding immediately after render to prevent flash
        if (typeof handlePastEvents === 'function') handlePastEvents();
        if (data.events && data.events.length > 0) { 
            calendarLoaded = true; 
        }
        
        if (window.markDataRefresh) window.markDataRefresh();
    } catch (error) {
        console.error('Calendar fetch failed:', error);
    }
}

// Render calendar events into 5 columns
function renderCalendar(events) {
    if (!events || events.length === 0) {
        if (calendarLoaded) return;
        return;
    }
    
    const eventsByDate = {};
    events.forEach(event => {
        if (!eventsByDate[event.date]) {
            eventsByDate[event.date] = [];
        }
        eventsByDate[event.date].push(event);
    });
    
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const numDays = displayConfig.calendarDays || 5;
    
    // Generate consecutive days starting from today (never skip days)
    const dates = [];
    for (let d = 0; d < numDays; d++) {
        const date = new Date(today);
        date.setDate(date.getDate() + d);
        const dateStr = date.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' });
        dates.push({ dateObj: date, dateStr });
    }
    
    for (let i = 0; i < numDays; i++) {
        const column = document.querySelector(`.calendar-column[data-day="${i}"]`);
        if (!column) continue;
        const eventsContainer = column.querySelector('.column-events');
        const header = column.querySelector('.column-header');
        
        const { dateObj, dateStr } = dates[i];
        // Find matching events by comparing the date string from the API
        const matchingKey = Object.keys(eventsByDate).find(key => {
            const parsed = parseDateString(key);
            parsed.setHours(0, 0, 0, 0);
            return parsed.getTime() === dateObj.getTime();
        });
        const dateEvents = matchingKey ? eventsByDate[matchingKey] : [];
            
            const dayNum = dateObj.getDate();
            const isToday = dateObj.getTime() === today.getTime();
            const dayName = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            
            if (isToday) {
                column.classList.add('today-column');
            } else {
                column.classList.remove('today-column');
            }
            
            header.querySelector('.column-date').textContent = dayNum;
            header.querySelector('.column-day').textContent = dayName;
            
            dateEvents.sort((a, b) => {
                if (a.allDay && !b.allDay) return -1;
                if (!a.allDay && b.allDay) return 1;
                if (a.allDay && b.allDay) return 0;
                return parseTimeTo24(a.startTime) - parseTimeTo24(b.startTime);
            });

            let html = '';
            if (dateEvents.length === 0) {
                html = '<div class="no-events">No events</div>';
            } else {
                dateEvents.forEach(event => {
                    const calClass = getCalendarClass(event.calendar);
                    const calColor = getCalendarColor(event.calendar);
                    const colorStyle = calColor ? ` style="border-left-color: ${escapeHtml(calColor)};"` : '';
                    
                    if (event.allDay) {
                        html += `<div class="calendar-event all-day ${calClass}"${colorStyle}>`;
                        html += `<div class="event-label">All day</div>`;
                        html += `<div class="event-title">${escapeHtml(event.title)}</div>`;
                        html += `</div>`;
                    } else {
                        html += `<div class="calendar-event ${calClass}"${colorStyle}>`;
                        html += `<div class="event-time">${escapeHtml(event.startTime)} - ${escapeHtml(event.endTime)}</div>`;
                        html += `<div class="event-title">${escapeHtml(event.title)}</div>`;
                        if (event.location) {
                            html += `<div class="event-location">📍 ${escapeHtml(event.location)}</div>`;
                        }
                        html += `</div>`;
                    }
                });
            }
            
            eventsContainer.innerHTML = html;
    }
}

// Parse "9:00 AM" or "1:30 PM" to minutes since midnight for sorting
function parseTimeTo24(timeStr) {
    if (!timeStr) return 9999;
    const match = timeStr.match(/(\d+):(\d+)\s*(AM|PM)/i);
    if (!match) return 9999;
    let hours = parseInt(match[1]);
    const minutes = parseInt(match[2]);
    const isPM = match[3].toUpperCase() === 'PM';
    if (isPM && hours !== 12) hours += 12;
    if (!isPM && hours === 12) hours = 0;
    return hours * 60 + minutes;
}

// Parse date string like "Saturday, Feb 14"
function parseDateString(dateStr) {
    const now = new Date();
    const year = now.getFullYear();
    
    const parts = dateStr.match(/(\w+),?\s+(\w+)\s+(\d+)/);
    if (parts) {
        const monthStr = parts[2];
        const day = parseInt(parts[3]);
        
        const monthMap = {
            'Jan': 0, 'Feb': 1, 'Mar': 2, 'Apr': 3, 'May': 4, 'Jun': 5,
            'Jul': 6, 'Aug': 7, 'Sep': 8, 'Oct': 9, 'Nov': 10, 'Dec': 11
        };
        
        const month = monthMap[monthStr];
        return new Date(year, month, day);
    }
    
    return now;
}

// Get CSS class for calendar type
function getCalendarClass(calendar) {
    const cal = calendar.toLowerCase();
    if (cal.includes('family')) return 'family';
    if (cal.includes('swim')) return 'swim';
    if (cal.includes('crew')) return 'crew';
    if (cal.includes('work')) return 'work';
    return 'family';
}

// Get calendar color from config map
function getCalendarColor(calendarName) {
    if (calendarColorMap[calendarName]) {
        return calendarColorMap[calendarName];
    }
    
    const nameLower = calendarName.toLowerCase();
    for (const [name, color] of Object.entries(calendarColorMap)) {
        if (nameLower.includes(name.toLowerCase()) || name.toLowerCase().includes(nameLower)) {
            return color;
        }
    }
    return null;
}

// Load photos list. The server already shuffles, so we just kick off the slideshow.
async function loadPhotos() {
    try {
        const response = await fetch('/api/photos');
        const data = await response.json();
        photos = data.photos || [];
        currentPhotoIndex = 0;
        if (photos.length > 0) showNextPhoto();
        if (window.markDataRefresh) window.markDataRefresh();
    } catch (error) {
        console.error('Photos fetch failed:', error);
    }
}

// Apply photo style class to both background layers
function applyPhotoStyle(style) {
    const mainDiv = document.getElementById('photo-background');
    const nextDiv = document.getElementById('photo-background-next');
    const styleClass = 'photo-style-' + (style || 'fill');
    const allStyles = ['photo-style-fill', 'photo-style-fit', 'photo-style-stretch', 'photo-style-zoom', 'photo-style-kenburns'];

    [mainDiv, nextDiv].forEach(div => {
        if (!div) return;
        allStyles.forEach(cls => div.classList.remove(cls));
        div.classList.add(styleClass);
    });
}

// Reset kenburns animation so it restarts fresh on each photo change
function resetKenburnsAnimation(div) {
    div.classList.remove('photo-style-kenburns');
    // Force reflow to restart the animation
    void div.offsetWidth;
    div.classList.add('photo-style-kenburns');
}

// Show next photo in slideshow
let currentPhotoLayer = 'main';
function showNextPhoto() {
    if (photos.length === 0) return;
    
    const mainDiv = document.getElementById('photo-background');
    const nextDiv = document.getElementById('photo-background-next');
    const newUrl = photos[currentPhotoIndex];
    const photoStyle = displayConfig.photoStyle || 'fill';
    
    const crossfadeDuration = (displayConfig.crossfadeDuration || 2) * 1000;
    
    mainDiv.style.transition = `opacity ${crossfadeDuration}ms ease-in-out`;
    nextDiv.style.transition = `opacity ${crossfadeDuration}ms ease-in-out`;
    
    if (currentPhotoLayer === 'main') {
        nextDiv.style.backgroundImage = `url('${newUrl}')`;
        if (photoStyle === 'kenburns') resetKenburnsAnimation(nextDiv);
        nextDiv.style.opacity = 1;
        mainDiv.style.opacity = 0;
        currentPhotoLayer = 'next';
    } else {
        mainDiv.style.backgroundImage = `url('${newUrl}')`;
        if (photoStyle === 'kenburns') resetKenburnsAnimation(mainDiv);
        mainDiv.style.opacity = 1;
        nextDiv.style.opacity = 0;
        currentPhotoLayer = 'main';
    }
    
    currentPhotoIndex = (currentPhotoIndex + 1) % photos.length;
}

// Map SVG icon paths to Weather Icons font classes
function svgToWeatherIcon(iconPath) {
    const map = {
        'clear-day': 'wi-day-sunny',
        'clear-night': 'wi-night-clear',
        'partly-cloudy-day': 'wi-day-cloudy',
        'partly-cloudy-night': 'wi-night-alt-cloudy',
        'partly-cloudy-day-rain': 'wi-day-rain',
        'partly-cloudy-day-snow': 'wi-day-snow',
        'overcast': 'wi-cloudy',
        'cloudy': 'wi-cloudy',
        'fog': 'wi-fog',
        'drizzle': 'wi-sprinkle',
        'rain': 'wi-rain',
        'extreme-rain': 'wi-rain-wind',
        'snow': 'wi-snow',
        'heavy-snow': 'wi-snow-wind',
        'snow-wind': 'wi-snow-wind',
        'sleet': 'wi-sleet',
        'hail': 'wi-hail',
        'thunderstorms-rain': 'wi-thunderstorm',
    };
    const name = (iconPath || '').replace(/^\/icons\//, '').replace(/\.svg$/, '');
    return map[name] || 'wi-cloudy';
}

// Apply display config
async function applyDisplayConfig() {
    try {
        const r = await fetch('/api/config');
        const cfg = await r.json();
        displayConfig = cfg.display || {};
        
        const pct = cfg.display?.panelOpacity ?? 20;
        let opacity = pct / 100;
        
        if (cfg.display?.nightModeEnabled && cfg.display?.nightModeAction === 'dim') {
            const now = new Date();
            const hhmm = now.getHours() * 100 + now.getMinutes();
            const start = parseInt((cfg.display.nightModeStart || '22:00').replace(':', '')) || 2200;
            const end = parseInt((cfg.display.nightModeEnd || '06:00').replace(':', '')) || 600;
            const isNightTime = start > end ? (hhmm >= start || hhmm < end) : (hhmm >= start && hhmm < end);
            
            if (isNightTime) {
                opacity = Math.min(1, opacity + 0.4);
            }
        }
        
        const overlay = document.querySelector('.brightness-overlay');
        if (overlay) overlay.style.background = `rgba(0, 0, 0, ${opacity})`;
        
        calendarColorMap = {};
        if (cfg.calendars) {
            cfg.calendars.forEach(cal => {
                if (cal.name && cal.color) {
                    calendarColorMap[cal.name] = cal.color;
                }
            });
        }

        // Apply photo style
        applyPhotoStyle(cfg.display?.photoStyle || 'fill');
        
        return cfg;
    } catch(e) { 
        console.error('Display config error:', e); 
        return { display: {} };
    }
}

// Initialize dashboard
async function init() {
    const cfg = await applyDisplayConfig();
    const display = cfg.display || {};
    
    updateClock();
    updateWeather();
    updateCalendar();
    loadPhotos();
    
    const photoInterval = (display.photoInterval || 30) * 60 * 1000;
    const weatherRefresh = (display.weatherRefresh || 10) * 60 * 1000;
    const calendarRefresh = (display.calendarRefresh || 5) * 60 * 1000;
    
    setInterval(updateClock, 1000);
    setInterval(updateWeather, weatherRefresh);
    const wxRetry = setInterval(() => { 
        updateWeather().then(() => clearInterval(wxRetry)).catch(() => {}); 
    }, 10000);
    setInterval(updateCalendar, calendarRefresh);
    const calRetry = setInterval(() => { 
        if (!calendarLoaded) { 
            updateCalendar(); 
        } else { 
            clearInterval(calRetry); 
        } 
    }, 10000);
    setInterval(showNextPhoto, photoInterval);
    setInterval(applyDisplayConfig, 5 * 60 * 1000);
    
    // Hide loading indicator after 30 seconds regardless of API success/failure
    setTimeout(() => {
        const loader = document.getElementById('loading-indicator');
        if (loader) loader.style.display = 'none';
    }, 30000);
}

// Start when page loads
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
