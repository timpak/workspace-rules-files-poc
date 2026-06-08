(function() {
	var container = fragmentElement.querySelector('.devcon-sessions-grid');
	var scopeId = Liferay.ThemeDisplay.getScopeGroupId();

	function sortTime(t) {
		var m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
		if (!m) return 0;
		var h = parseInt(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0);
		return h * 60 + parseInt(m[2]);
	}

	function roomBadgeClass(room) {
		if (!room || room.toLowerCase().includes('main')) return 'devcon-badge-main';
		if (room.includes('A')) return 'devcon-badge-a';
		if (room.includes('C')) return 'devcon-badge-c';
		return 'devcon-badge-b';
	}

	var speakerFilter = new URLSearchParams(location.search).get('speaker');

	Liferay.Util.fetch('/o/c/sessions/scopes/' + scopeId + '?nestedFields=sessionSpeakers&pageSize=100')
		.then(function(r) { return r.json(); })
		.then(function(data) {
			var sessions = data.items || [];

			if (speakerFilter) {
				sessions = sessions.filter(function(s) {
					return (s.sessionSpeakers || []).some(function(sp) {
						return sp.name === speakerFilter;
					});
				});
				var clearUrl = location.pathname;
				container.insertAdjacentHTML('beforebegin',
					'<div class="devcon-filter-banner">' +
						'Sessions by <strong>' + speakerFilter + '</strong>' +
						'&nbsp;&nbsp;<a href="' + clearUrl + '" class="devcon-filter-clear">Clear filter</a>' +
					'</div>'
				);
			}

			if (!sessions.length) {
				container.innerHTML = '<p>No sessions found.</p>';
				return;
			}

			var byTime = {};
			sessions.forEach(function(s) {
				var t = s.startTime || 'TBD';
				if (!byTime[t]) byTime[t] = [];
				byTime[t].push(s);
			});

			var slots = Object.keys(byTime).sort(function(a, b) {
				return sortTime(a) - sortTime(b);
			});

			container.innerHTML = slots.map(function(time, idx) {
				var isLast = idx === slots.length - 1;
				var slotSessions = byTime[time];
				var isPlenary = slotSessions.length === 1 && slotSessions[0].room && slotSessions[0].room.toLowerCase().includes('main');

				var cards = slotSessions.map(function(s) {
					var speakers = (s.sessionSpeakers || []).map(function(sp) { return sp.name; }).join(', ');
					var badgeClass = roomBadgeClass(s.room);
					return '<div class="devcon-session-card' + (isPlenary ? ' devcon-session-plenary' : '') + '">' +
						'<span class="devcon-session-room-badge ' + badgeClass + '">' + (s.room || 'TBD') + '</span>' +
						'<h3 class="devcon-session-title">' + s.title + '</h3>' +
						(speakers ? '<p class="devcon-session-speaker">' + speakers + '</p>' : '') +
					'</div>';
				}).join('');

				return '<div class="devcon-timeline-slot">' +
					'<div class="devcon-timeline-time">' +
						'<span class="devcon-time-dot"></span>' +
						'<span class="devcon-time-label">' + time + '</span>' +
						(!isLast ? '<span class="devcon-time-connector"></span>' : '') +
					'</div>' +
					'<div class="devcon-timeline-cards' + (isPlenary ? ' devcon-timeline-plenary' : '') + '">' +
						cards +
					'</div>' +
				'</div>';
			}).join('');
		})
		.catch(function() {
			container.innerHTML = '<p>Could not load sessions.</p>';
		});
})();
