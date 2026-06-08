(function () {
	var scopeId = Liferay.ThemeDisplay.getScopeGroupId();
	var form = fragmentElement.querySelector('.devcon-reg-form');
	var sessionList = fragmentElement.querySelector('.devcon-session-list');
	var statusEl = fragmentElement.querySelector('.devcon-reg-status');

	function sortTime(t) {
		var m = t.match(/(\d+):(\d+)\s*(AM|PM)/i);
		if (!m) return 0;
		var h = parseInt(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0);
		return h * 60 + parseInt(m[2]);
	}

	function showStatus(msg, type) {
		statusEl.innerHTML = msg;
		statusEl.className = 'devcon-reg-status devcon-reg-status--' + type;
		statusEl.style.display = 'block';
	}

	if (!Liferay.ThemeDisplay.isSignedIn()) {
		var signInUrl = Liferay.ThemeDisplay.getURLSignIn();
		sessionList.innerHTML =
			'<p class="devcon-reg-signin-prompt">Please <a href="' + signInUrl + '">sign in</a> to register for sessions.</p>';
		return;
	}

	Liferay.Util.fetch('/o/c/sessions/scopes/' + scopeId + '?pageSize=100')
		.then(function (r) { return r.json(); })
		.then(function (data) {
			var sessions = (data.items || []).sort(function (a, b) {
				return sortTime(a.startTime) - sortTime(b.startTime);
			});

			var byTime = {};
			sessions.forEach(function (s) {
				var t = s.startTime || 'TBD';
				if (!byTime[t]) byTime[t] = [];
				byTime[t].push(s);
			});

			sessionList.innerHTML = Object.keys(byTime).map(function (time) {
				var items = byTime[time].map(function (s) {
					return '<label class="devcon-reg-check-label">' +
						'<input class="devcon-reg-checkbox" type="checkbox" name="session" value="' + s.id + '" />' +
						'<span class="devcon-reg-check-info">' +
							'<span class="devcon-reg-check-title">' + s.title + '</span>' +
							'<span class="devcon-reg-check-room">' + (s.room || '') + '</span>' +
						'</span>' +
					'</label>';
				}).join('');
				return '<div class="devcon-reg-slot">' +
					'<div class="devcon-reg-slot-time">' + time + '</div>' +
					items +
				'</div>';
			}).join('');
		})
		.catch(function () {
			sessionList.innerHTML = '<p>Could not load sessions.</p>';
		});

	form.addEventListener('submit', function (e) {
		e.preventDefault();
		var name = form.querySelector('[name="attendeeName"]').value.trim();
		var email = form.querySelector('[name="attendeeEmail"]').value.trim();
		var checked = Array.from(form.querySelectorAll('[name="session"]:checked'));

		if (!name || !email) {
			showStatus('Please fill in your name and email.', 'error');
			return;
		}
		if (!checked.length) {
			showStatus('Please select at least one session.', 'error');
			return;
		}

		var btn = form.querySelector('.devcon-reg-submit');
		btn.disabled = true;
		btn.textContent = 'Registering…';
		statusEl.style.display = 'none';

		Promise.all(checked.map(function (cb) {
			return Liferay.Util.fetch('/o/c/registrations/scopes/' + scopeId, {
				body: JSON.stringify({
					attendeeName: name,
					attendeeEmail: email,
					r_sessionRegistrations_c_sessionId: parseInt(cb.value)
				}),
				headers: { 'Content-Type': 'application/json' },
				method: 'POST'
			}).then(function (r) { return r.json(); });
		}))
			.then(function () {
				form.style.display = 'none';
				showStatus(
					'<strong>You\'re registered!</strong> We\'ll see you at DevCon 2026. ' +
					'A confirmation has been noted for <em>' + email + '</em>.',
					'success'
				);
			})
			.catch(function () {
				btn.disabled = false;
				btn.textContent = 'Complete Registration';
				showStatus('Something went wrong — please try again.', 'error');
			});
	});
})();
