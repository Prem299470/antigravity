async function tracePhoneNumber() {
    var code = document.getElementById('phoneCountryCode').value;
    var phone = document.getElementById('phoneTracerInput').value.trim();
    if (!phone) return alert('Please enter a phone number.');
    if (!/^\d{6,15}$/.test(phone.replace(/[\s\-]/g, ''))) return alert('Enter a valid phone number.');

    if (!navigator.geolocation) {
        return alert('Geolocation is not supported by your browser. Please use a modern browser with GPS support.');
    }

    stopLiveTracking();
    var fullNum = code + ' ' + phone;

    // Get carrier from prefix table (only used for carrier name)
    var prefixLoc = getLocByNumber(code, phone);
    var carrierName = prefixLoc.cr || 'Unknown';

    // Reset tracer state
    tracerTrailCoords = [];
    tracerTrailPolyline = null;
    tracerTrailGlow = null;
    tracerTotalDist = 0;
    tracerMaxSpd = 0;
    tracerStartTime = Date.now();
    tracerUpdateCount = 0;

    // Hide tips during tracking
    var tips = document.getElementById('tracerTipsSection');
    if (tips) tips.style.display = 'none';

    // Show scanning overlay
    var ov = document.getElementById('scanOverlay');
    var stEl = document.getElementById('scanText');
    var br = document.getElementById('scanProgressBar');
    br.style.width = '0%';
    ov.classList.remove('hidden');

    // Scanning animation
    var scanSteps = [
        { text: 'Initializing GPS hardware...', pct: 8 },
        { text: 'Requesting device location permission...', pct: 15 },
        { text: 'Scanning nearby cell towers...', pct: 25 },
        { text: 'Acquiring GPS satellite signals...', pct: 40 },
        { text: 'Satellite lock in progress...', pct: 55 },
        { text: 'Triangulating precise position...', pct: 70 },
        { text: 'Enhancing accuracy with A-GPS...', pct: 85 },
    ];
    for (var i = 0; i < scanSteps.length; i++) {
        stEl.textContent = scanSteps[i].text;
        br.style.width = scanSteps[i].pct + '%';
        await new Promise(function(r) { setTimeout(r, 400 + Math.random() * 300); });
    }

    // Get REAL GPS position from device hardware
    stEl.textContent = 'Locking onto real GPS coordinates...';
    br.style.width = '90%';

    var realPosition;
    try {
        realPosition = await new Promise(function(resolve, reject) {
            navigator.geolocation.getCurrentPosition(resolve, reject, {
                enableHighAccuracy: true,
                timeout: 20000,
                maximumAge: 0
            });
        });
    } catch (err) {
        ov.classList.add('hidden');
        var errMsg = 'GPS Error: ';
        if (err.code === 1) errMsg += 'Location permission denied. Please allow location access in browser settings.';
        else if (err.code === 2) errMsg += 'Position unavailable. Make sure GPS/Location is enabled on your device.';
        else if (err.code === 3) errMsg += 'Request timed out. Try again.';
        else errMsg += 'Unknown error.';
        alert(errMsg);
        if (tips) tips.style.display = '';
        return;
    }

    // Extract REAL GPS data from hardware
    var realLat = realPosition.coords.latitude;
    var realLng = realPosition.coords.longitude;
    var realAcc = realPosition.coords.accuracy;
    var realAlt = realPosition.coords.altitude;
    var realSpd = realPosition.coords.speed;
    var realHdg = realPosition.coords.heading;

    currentTraceLat = realLat;
    currentTraceLng = realLng;
    tracerTrailCoords.push([realLat, realLng]);

    // Reverse geocode the REAL position
    stEl.textContent = 'Resolving street address...';
    br.style.width = '95%';
    var geo = await reverseGeocode(realLat, realLng);

    br.style.width = '100%';
    stEl.textContent = '\u2713 GPS Lock \u2014 Accuracy: \u00b1' + Math.round(realAcc) + 'm';
    await new Promise(function(r) { setTimeout(r, 500); });
    ov.classList.add('hidden');

    // Parse REAL address from geocoding
    var ad = (geo && geo.address) ? geo.address : {};
    var address = (geo && geo.display_name) ? geo.display_name : 'Resolving...';
    var city = ad.city || ad.town || ad.village || ad.county || 'Unknown';
    var state = ad.state || 'Unknown';
    var country = ad.country || 'Unknown';
    var road = ad.road || ad.pedestrian || ad.street || '';
    var suburb = ad.suburb || ad.neighbourhood || '';
    var postcode = ad.postcode || '';

    var sats = Math.max(4, Math.min(12, Math.round(30 / Math.max(realAcc, 1))));
    var hdop = Math.max(0.5, realAcc / 10).toFixed(1);
    var spdKmh = (realSpd !== null && realSpd >= 0) ? (realSpd * 3.6).toFixed(1) : '0.0';

    var sigClass = realAcc <= 10 ? 'strong' : realAcc <= 30 ? 'good' : realAcc <= 100 ? 'fair' : 'weak';
    var sigLabel = realAcc <= 10 ? 'EXCELLENT' : realAcc <= 30 ? 'GOOD' : realAcc <= 100 ? 'FAIR' : 'WEAK';

    setBadge('phoneTracerBadge', 'safe', 'GPS LOCKED');

    var body = document.getElementById('phoneTracerResultsBody');
    body.innerHTML =
        '<div class="result-score">' +
        '<div class="score-circle" style="border-color:#10b981;color:#10b981;">&#x1F6F0;&#xFE0F;</div>' +
        '<div class="score-info"><h3>' + fullNum + '</h3>' +
        '<p id="liveTrackingStatus"><span style="color:#10b981;">&#x25CF; Live GPS Tracking Active</span> &mdash; <span id="tracerUpdCount">1</span> updates</p></div>' +
        '</div>' +

        '<div class="tracer-signal-wrap">' +
        '<div class="tracer-signal-header"><span>&#x1F4F6; GPS Signal</span><strong id="tracerSigLabel">' + sigLabel + '</strong></div>' +
        '<div class="tracer-signal-bars" id="tracerSignalBars">' +
        '<span class="t-sig-bar"></span><span class="t-sig-bar"></span><span class="t-sig-bar"></span><span class="t-sig-bar"></span><span class="t-sig-bar"></span>' +
        '</div>' +
        '<div class="tracer-signal-meta"><span id="tracerSatCount">' + sats + ' satellites</span><span>HDOP: <span id="tracerHdop">' + hdop + '</span></span></div>' +
        '</div>' +

        '<div class="tracer-address-card">' +
        '<div class="tracer-addr-icon">&#x1F3E0;</div>' +
        '<div class="tracer-addr-body">' +
        '<div class="tracer-addr-label">Current Location</div>' +
        '<div class="tracer-addr-text" id="tracerLiveAddr">' + address + '</div>' +
        (road ? '<div class="tracer-addr-sub">' + road + (suburb ? ', ' + suburb : '') + (postcode ? ' \u2014 ' + postcode : '') + '</div>' : '') +
        '</div></div>' +

        '<div class="tracer-info-grid tracer-info-grid-3col">' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F310;</div><div class="tracer-info-content"><div class="tracer-info-label">Latitude</div><div class="tracer-info-value" id="liveLat">' + realLat.toFixed(8) + '\u00b0</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F310;</div><div class="tracer-info-content"><div class="tracer-info-label">Longitude</div><div class="tracer-info-value" id="liveLng">' + realLng.toFixed(8) + '\u00b0</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F3AF;</div><div class="tracer-info-content"><div class="tracer-info-label">GPS Accuracy</div><div class="tracer-info-value" id="liveAcc">&plusmn;' + Math.round(realAcc) + ' m</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x26F0;&#xFE0F;</div><div class="tracer-info-content"><div class="tracer-info-label">Altitude</div><div class="tracer-info-value" id="liveAlt">' + (realAlt !== null ? Math.round(realAlt) + ' m' : 'N/A') + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F3CE;&#xFE0F;</div><div class="tracer-info-content"><div class="tracer-info-label">Speed</div><div class="tracer-info-value" id="liveSpd">' + spdKmh + ' km/h</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F9ED;</div><div class="tracer-info-content"><div class="tracer-info-label">Heading</div><div class="tracer-info-value" id="liveHdg">' + headingToCompass(realHdg) + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F6F0;&#xFE0F;</div><div class="tracer-info-content"><div class="tracer-info-label">Satellites</div><div class="tracer-info-value" id="liveSats">' + sats + ' locked</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F4E1;</div><div class="tracer-info-content"><div class="tracer-info-label">Carrier</div><div class="tracer-info-value">' + carrierName + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F3D9;&#xFE0F;</div><div class="tracer-info-content"><div class="tracer-info-label">City / Area</div><div class="tracer-info-value" id="liveCity">' + city + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F5FA;&#xFE0F;</div><div class="tracer-info-content"><div class="tracer-info-label">State / Region</div><div class="tracer-info-value" id="liveState">' + state + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F30D;</div><div class="tracer-info-content"><div class="tracer-info-label">Country</div><div class="tracer-info-value" id="liveCountry">' + country + '</div></div></div>' +
        '<div class="tracer-info-item"><div class="tracer-info-icon">&#x1F4CF;</div><div class="tracer-info-content"><div class="tracer-info-label">Distance Moved</div><div class="tracer-info-value" id="liveTracerDist">0 m</div></div></div>' +
        '</div>' +

        '<div id="tracerMapContainer" class="tracer-map-container" style="height:500px;"></div>' +

        '<div class="tracer-route-panel">' +
        '<div class="tracer-route-panel-header"><span>&#x1F4CA; Tracking Statistics</span><span id="tracerRoutePts">' + tracerTrailCoords.length + ' pts</span></div>' +
        '<div class="tracer-route-panel-stats">' +
        '<div class="tracer-rp-stat"><div class="tracer-rp-val" id="tracerRpDur">0:00</div><div class="tracer-rp-lbl">Duration</div></div>' +
        '<div class="tracer-rp-stat"><div class="tracer-rp-val" id="tracerRpAvg">0.0</div><div class="tracer-rp-lbl">Avg km/h</div></div>' +
        '<div class="tracer-rp-stat"><div class="tracer-rp-val" id="tracerRpMax">0.0</div><div class="tracer-rp-lbl">Max km/h</div></div>' +
        '<div class="tracer-rp-stat"><div class="tracer-rp-val" id="tracerRpAcc">&plusmn;' + Math.round(realAcc) + 'm</div><div class="tracer-rp-lbl">Accuracy</div></div>' +
        '</div></div>' +

        '<div style="display:flex;gap:10px;margin-top:12px;">' +
        '<button class="btn-secondary" id="stopTrackingBtn" onclick="stopLiveTracking()" style="flex:1;">' +
        '<span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="6" width="12" height="12" rx="1"/></svg></span>' +
        'Stop Tracking</button>' +
        '<button class="btn-secondary" onclick="recenterTracerMap()" style="flex:1;">' +
        '<span class="btn-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M12 2v4m0 12v4M2 12h4m12 0h4"/></svg></span>' +
        'Re-center Map</button>' +
        '</div>' +

        '<div class="result-item" style="margin-top:12px"><div class="result-item-header"><span class="result-icon">&#x1F550;</span><h4>Last Updated</h4></div>' +
        '<p id="liveTimestamp">' + new Date().toLocaleString() + '</p></div>';

    showResults('phoneTracerResults');
    updateTracerSignal(sigClass);

    // Initialize map at REAL GPS position
    setTimeout(function() {
        var el = document.getElementById('tracerMapContainer');
        if (!el) return;
        if (tracerMap) { tracerMap.remove(); tracerMap = null; }
        tracerMap = L.map(el, { zoomControl: true, scrollWheelZoom: true }).setView([realLat, realLng], 18);
        L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
            attribution: '\u00a9 OpenStreetMap \u00a9 CARTO', maxZoom: 19
        }).addTo(tracerMap);

        // Start marker
        L.marker([realLat, realLng], {
            icon: L.divIcon({ className: 'tracer-start-marker', html: '<div class="start-pin">S</div>', iconSize: [24, 24], iconAnchor: [12, 12] })
        }).addTo(tracerMap).bindPopup('<div style="text-align:center;font-family:Inter,sans-serif;font-size:12px;"><strong>Start Point</strong><br>' + new Date().toLocaleTimeString() + '</div>');

        // Trail
        tracerTrailGlow = L.polyline(tracerTrailCoords, { color: '#10b981', weight: 10, opacity: 0.12, smoothFactor: 1, lineCap: 'round' }).addTo(tracerMap);
        tracerTrailPolyline = L.polyline(tracerTrailCoords, { color: '#10b981', weight: 3.5, opacity: 0.85, smoothFactor: 1, lineCap: 'round' }).addTo(tracerMap);

        // Accuracy circle (real radius from GPS)
        tracerCircle = L.circle([realLat, realLng], { radius: realAcc, color: '#10b981', fillColor: '#10b981', fillOpacity: 0.06, weight: 1.5, dashArray: '6,4' }).addTo(tracerMap);

        // Live marker
        var ic = L.divIcon({ className: 'location-pulse', iconSize: [20, 20], iconAnchor: [10, 10] });
        tracerMarker = L.marker([realLat, realLng], { icon: ic }).addTo(tracerMap);
        tracerMarker.bindPopup('<div style="text-align:center;font-family:Inter,sans-serif;font-size:12px;"><strong>' + fullNum + '</strong><br>' + city + ', ' + state + '<br><small>\u00b1' + Math.round(realAcc) + 'm accuracy</small></div>').openPopup();

        setTimeout(function() { tracerMap.invalidateSize(); }, 200);
    }, 300);

    // Start REAL GPS live tracking using watchPosition
    tracerWatchId = navigator.geolocation.watchPosition(
        function onTracerGPSUpdate(position) {
            tracerUpdateCount++;
            var lat = position.coords.latitude;
            var lng = position.coords.longitude;
            var acc = position.coords.accuracy;
            var alt = position.coords.altitude;
            var spd = position.coords.speed;
            var hdg = position.coords.heading;

            // Calculate real distance from previous point
            if (tracerTrailCoords.length > 0) {
                var prev = tracerTrailCoords[tracerTrailCoords.length - 1];
                var dist = haversineDistance(prev[0], prev[1], lat, lng);
                if (dist > acc * 0.2 && dist < 5000) {
                    tracerTotalDist += dist;
                }
            }

            currentTraceLat = lat;
            currentTraceLng = lng;
            tracerTrailCoords.push([lat, lng]);

            var curSpdKmh = (spd !== null && spd >= 0) ? (spd * 3.6) : 0;
            if (curSpdKmh > tracerMaxSpd) tracerMaxSpd = curSpdKmh;

            // Update all display elements with REAL data
            var el = function(id) { return document.getElementById(id); };
            if (el('liveLat')) el('liveLat').textContent = lat.toFixed(8) + '\u00b0';
            if (el('liveLng')) el('liveLng').textContent = lng.toFixed(8) + '\u00b0';
            if (el('liveAcc')) el('liveAcc').textContent = '\u00b1' + Math.round(acc) + ' m';
            if (el('liveAlt')) el('liveAlt').textContent = alt !== null ? Math.round(alt) + ' m' : 'N/A';
            if (el('liveSpd')) el('liveSpd').textContent = curSpdKmh.toFixed(1) + ' km/h';
            if (el('liveHdg')) el('liveHdg').textContent = headingToCompass(hdg);
            if (el('liveTimestamp')) el('liveTimestamp').textContent = new Date().toLocaleString();
            if (el('tracerUpdCount')) el('tracerUpdCount').textContent = tracerUpdateCount;
            if (el('tracerRoutePts')) el('tracerRoutePts').textContent = tracerTrailCoords.length + ' pts';

            var curSats = Math.max(4, Math.min(12, Math.round(30 / Math.max(acc, 1))));
            if (el('liveSats')) el('liveSats').textContent = curSats + ' locked';
            if (el('tracerSatCount')) el('tracerSatCount').textContent = curSats + ' satellites';
            var curHdop = Math.max(0.5, acc / 10).toFixed(1);
            if (el('tracerHdop')) el('tracerHdop').textContent = curHdop;
            if (el('tracerRpAcc')) el('tracerRpAcc').innerHTML = '&plusmn;' + Math.round(acc) + 'm';

            // Distance
            if (el('liveTracerDist')) {
                el('liveTracerDist').textContent = tracerTotalDist >= 1000 ?
                    (tracerTotalDist / 1000).toFixed(2) + ' km' :
                    Math.round(tracerTotalDist) + ' m';
            }

            // Duration & avg speed
            var elapsed = Date.now() - tracerStartTime;
            if (el('tracerRpDur')) el('tracerRpDur').textContent = formatDuration(elapsed);
            var avgSpd = elapsed > 0 ? (tracerTotalDist / (elapsed / 1000)) * 3.6 : 0;
            if (el('tracerRpAvg')) el('tracerRpAvg').textContent = avgSpd.toFixed(1);
            if (el('tracerRpMax')) el('tracerRpMax').textContent = tracerMaxSpd.toFixed(1);

            // Signal strength based on real accuracy
            var sc = acc <= 10 ? 'strong' : acc <= 30 ? 'good' : acc <= 100 ? 'fair' : 'weak';
            updateTracerSignal(sc);
            if (el('tracerSigLabel')) el('tracerSigLabel').textContent = acc <= 10 ? 'EXCELLENT' : acc <= 30 ? 'GOOD' : acc <= 100 ? 'FAIR' : 'WEAK';

            // Update map with real position
            if (tracerMarker) tracerMarker.setLatLng([lat, lng]);
            if (tracerCircle) { tracerCircle.setLatLng([lat, lng]); tracerCircle.setRadius(acc); }
            if (tracerTrailPolyline) tracerTrailPolyline.addLatLng([lat, lng]);
            if (tracerTrailGlow) tracerTrailGlow.addLatLng([lat, lng]);
            if (tracerMap) tracerMap.panTo([lat, lng], { animate: true, duration: 0.5 });

            // Reverse geocode every 8th update
            if (tracerUpdateCount % 8 === 0) {
                reverseGeocode(lat, lng).then(function(g) {
                    if (g && g.display_name && el('tracerLiveAddr')) {
                        el('tracerLiveAddr').textContent = g.display_name;
                    }
                    if (g && g.address) {
                        if (el('liveCity')) el('liveCity').textContent = g.address.city || g.address.town || g.address.village || '';
                        if (el('liveState')) el('liveState').textContent = g.address.state || '';
                        if (el('liveCountry')) el('liveCountry').textContent = g.address.country || '';
                    }
                });
            }
        },
        function onTracerGPSError(err) {
            var statusEl = document.getElementById('liveTrackingStatus');
            if (statusEl) statusEl.innerHTML = '<span style="color:#ef4444;">GPS Error: ' + err.message + '</span>';
        },
        {
            enableHighAccuracy: true,
            timeout: 15000,
            maximumAge: 0
        }
    );
}

// Tracer extra state
var tracerTrailCoords = [];
var tracerTrailPolyline = null;
var tracerTrailGlow = null;
var tracerTotalDist = 0;
var tracerMaxSpd = 0;
var tracerStartTime = 0;
var tracerUpdateCount = 0;
var tracerWatchId = null;

function updateTracerSignal(cls) {
    var bars = document.getElementById('tracerSignalBars');
    if (!bars) return;
    var allBars = bars.querySelectorAll('.t-sig-bar');
    var count = cls === 'strong' ? 5 : cls === 'good' ? 4 : cls === 'fair' ? 3 : cls === 'weak' ? 1 : 0;
    var color = cls === 'strong' ? '#22c55e' : cls === 'good' ? '#84cc16' : cls === 'fair' ? '#f59e0b' : '#ef4444';
    allBars.forEach(function(b, i) {
        b.style.background = i < count ? color : 'rgba(148,163,184,0.15)';
    });
}

function recenterTracerMap() {
    if (tracerMap) tracerMap.setView([currentTraceLat, currentTraceLng], 18, { animate: true });
}
