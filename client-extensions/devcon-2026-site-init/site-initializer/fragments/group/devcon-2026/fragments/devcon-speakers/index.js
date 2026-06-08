(function() {
	var grid = fragmentElement.querySelector('.devcon-speakers-grid');
	var scopeId = Liferay.ThemeDisplay.getScopeGroupId();

	function speakerPhotoUrl(speaker) {
		var seed = encodeURIComponent(speaker.name.replace(/\s+/g, ''));
		return 'https://api.dicebear.com/9.x/micah/svg?seed=' + seed + '&baseColor=f9c9b6,ac6651&backgroundColor=b6e3f4,c0aede,d1d4f9,ffd5dc,ffdfbf';
	}

	Liferay.Util.fetch('/o/c/speakers/scopes/' + scopeId + '?pageSize=100')
		.then(function(r) { return r.json(); })
		.then(function(data) {
			var speakers = data.items || [];
			if (!speakers.length) {
				grid.innerHTML = '<p>No speakers found.</p>';
				return;
			}
			var sessionsBase = '/web/devcon-2026/sessions';
			grid.innerHTML = speakers.map(function(speaker) {
				var photoUrl = speakerPhotoUrl(speaker);
				var href = sessionsBase + '?speaker=' + encodeURIComponent(speaker.name);
				return '<a class="devcon-speaker-card" data-speaker-id="' + speaker.id + '" href="' + href + '">' +
					'<div class="devcon-speaker-photo-wrap">' +
						'<img src="' + photoUrl + '" alt="' + speaker.name + '" class="devcon-speaker-photo" loading="lazy" />' +
					'</div>' +
					'<h3 class="devcon-speaker-name">' + speaker.name + '</h3>' +
					'<p class="devcon-speaker-title">' + (speaker.jobTitle || '') + '</p>' +
					'<p class="devcon-speaker-bio">' + (speaker.bio || '') + '</p>' +
				'</a>';
			}).join('');
		})
		.catch(function() {
			grid.innerHTML = '<p>Could not load speakers.</p>';
		});
})();
