(function () {
	var scopeId = Liferay.ThemeDisplay.getScopeGroupId();
	var content = fragmentElement.querySelector('.devcon-admin-content');

	function sortTime(t) {
		var m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
		if (!m) return 0;
		var h = parseInt(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0);
		return h * 60 + parseInt(m[2]);
	}

	Liferay.Util.fetch('/o/c/sessions/scopes/' + scopeId + '?nestedFields=sessionRegistrations&pageSize=100')
		.then(function (r) { return r.json(); })
		.then(function (data) {
			var sessions = (data.items || []).sort(function (a, b) {
				return sortTime(a.startTime) - sortTime(b.startTime);
			});

			var totalRegs = sessions.reduce(function (n, s) {
				return n + (s.sessionRegistrations || []).length;
			}, 0);

			var summaryHtml = '<div class="devcon-admin-summary">' +
				'<span class="devcon-admin-stat"><strong>' + sessions.length + '</strong> sessions</span>' +
				'<span class="devcon-admin-stat"><strong>' + totalRegs + '</strong> total registrations</span>' +
			'</div>';

			var cardsHtml = sessions.map(function (s) {
				var regs = s.sessionRegistrations || [];
				var attendeeRows = regs.length
					? regs.map(function (r) {
						return '<tr><td>' + r.attendeeName + '</td><td>' + r.attendeeEmail + '</td></tr>';
					}).join('')
					: '<tr><td colspan="2" class="devcon-admin-empty">No registrations yet</td></tr>';

				return '<div class="devcon-admin-card">' +
					'<div class="devcon-admin-card-header">' +
						'<div class="devcon-admin-card-meta">' +
							'<span class="devcon-admin-card-time">' + (s.startTime || 'TBD') + '</span>' +
							'<span class="devcon-admin-card-room">' + (s.room || '') + '</span>' +
						'</div>' +
						'<h3 class="devcon-admin-card-title">' + s.title + '</h3>' +
						'<span class="devcon-admin-card-count">' + regs.length + ' registered</span>' +
					'</div>' +
					'<table class="devcon-admin-table">' +
						'<thead><tr><th>Name</th><th>Email</th></tr></thead>' +
						'<tbody>' + attendeeRows + '</tbody>' +
					'</table>' +
				'</div>';
			}).join('');

			content.innerHTML = summaryHtml + cardsHtml;
		})
		.catch(function () {
			content.innerHTML = '<p>Could not load registration data.</p>';
		});
})();
