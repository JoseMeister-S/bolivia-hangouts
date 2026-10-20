// The loader animals (a blue lobster, a frog, an owl), drawn once here for
// every page. A plain script, not a module: it runs as soon as it arrives,
// before the modules, and fills each <span data-critter> with one animal at
// random (or the one it names: data-critter="owl"). Colors come from app.css;
// the eyes keep their colors in light and dark.
(function () {
  var animals = {
    lobster: [
      '<g class="wiggle">',
      '  <path class="k-none sway" d="M54 34 Q46 16 32 6"/>',
      '  <path class="k-none sway alt" d="M66 34 Q74 16 88 6"/>',
      '  <path class="k-none" d="M46 56 L32 54 M46 63 L31 68 M48 70 L35 79 M74 56 L88 54 M74 63 L89 68 M72 70 L85 79"/>',
      '  <path class="k-none" d="M48 46 Q40 46 34 40"/>',
      '  <path class="k-none" d="M72 46 Q80 46 86 40"/>',
      '  <g>',
      '    <path class="k-pewter" d="M35 42 C25 49 11 43 12 31 C12 22 14 15 18 9 C21 16 24 22 27 27 Z"/>',
      '    <path class="k-pewter snap" d="M27 28 C29 22 30 15 29 9 C35 14 37 24 33 32 Z"/>',
      '  </g>',
      '  <g transform="translate(120 0) scale(-1 1)">',
      '    <path class="k-pewter" d="M35 42 C25 49 11 43 12 31 C12 22 14 15 18 9 C21 16 24 22 27 27 Z"/>',
      '    <path class="k-pewter snap alt" d="M27 28 C29 22 30 15 29 9 C35 14 37 24 33 32 Z"/>',
      '  </g>',
      '  <path class="k-pewter" d="M47 110 Q60 120 73 110 L67 100 H53 Z"/>',
      '  <rect class="k-pewter" x="51" y="90" width="18" height="12" rx="5"/>',
      '  <rect class="k-pewter" x="49" y="80" width="22" height="12" rx="5"/>',
      '  <rect class="k-pewter" x="47" y="70" width="26" height="12" rx="5"/>',
      '  <ellipse class="k-pewter" cx="60" cy="54" rx="15" ry="19"/>',
      '  <path class="k-none" d="M55 52 q5 4 10 0"/>',
      '  <path class="k-none" d="M55 37 L52 30 M65 37 L68 30"/>',
      '  <g class="blink"><circle class="k-eye" cx="51" cy="27" r="5.5"/><circle class="k-pupil" cx="51.6" cy="26.4" r="2.6"/><circle class="k-shine" cx="52.6" cy="25.2" r="1"/></g>',
      '  <g class="blink"><circle class="k-eye" cx="69" cy="27" r="5.5"/><circle class="k-pupil" cx="68.4" cy="26.4" r="2.6"/><circle class="k-shine" cx="69.4" cy="25.2" r="1"/></g>',
      '</g>',
    ].join(''),
    frog: [
      '<ellipse class="k-ink shadow" cx="60" cy="110" rx="32" ry="4"/>',
      '<g class="hop">',
      '  <ellipse class="k-slate" cx="30" cy="94" rx="15" ry="10"/>',
      '  <ellipse class="k-slate" cx="90" cy="94" rx="15" ry="10"/>',
      '  <ellipse class="k-slate" cx="60" cy="78" rx="32" ry="25"/>',
      '  <ellipse class="k-pewter" cx="60" cy="88" rx="18" ry="12"/>',
      '  <circle class="k-slate" cx="42" cy="54" r="12.5"/>',
      '  <circle class="k-slate" cx="78" cy="54" r="12.5"/>',
      '  <g class="blink"><circle class="k-eye" cx="42" cy="54" r="8"/><ellipse class="k-pupil" cx="42.5" cy="54.5" rx="4.6" ry="3.4"/><circle class="k-shine" cx="44.2" cy="52.6" r="1.4"/></g>',
      '  <g class="blink"><circle class="k-eye" cx="78" cy="54" r="8"/><ellipse class="k-pupil" cx="77.5" cy="54.5" rx="4.6" ry="3.4"/><circle class="k-shine" cx="79.2" cy="52.6" r="1.4"/></g>',
      '  <path class="k-none" d="M45 70 Q60 79 75 70"/>',
      '  <ellipse class="k-cheek" cx="39" cy="69" rx="4.5" ry="3"/>',
      '  <ellipse class="k-cheek" cx="81" cy="69" rx="4.5" ry="3"/>',
      '  <path class="k-slate" d="M38 102 q2 -6 10 -6 q8 0 10 6 q-3 3 -6 0 q-2 3 -4 0 q-2 3 -4 0 q-3 3 -6 0 Z"/>',
      '  <path class="k-slate" d="M62 102 q2 -6 10 -6 q8 0 10 6 q-3 3 -6 0 q-2 3 -4 0 q-2 3 -4 0 q-3 3 -6 0 Z"/>',
      '</g>',
    ].join(''),
    owl: [
      '<path class="k-none" d="M12 106 H108"/>',
      '<g class="bob">',
      '  <ellipse class="k-bronze" cx="60" cy="76" rx="26" ry="28"/>',
      '  <ellipse class="k-tan flat" cx="60" cy="82" rx="15" ry="18"/>',
      '  <path class="k-none" d="M53 78 l3.5 3 l3.5 -3 l3.5 3 l3.5 -3 M56.5 88 l3.5 3 l3.5 -3"/>',
      '  <path class="k-mahogany" d="M35 64 C27 78 29 94 39 100 C40 88 40 76 35 64 Z"/>',
      '  <path class="k-mahogany" d="M85 64 C93 78 91 94 81 100 C80 88 80 76 85 64 Z"/>',
      '  <path class="k-none" d="M49 101 l-1.5 5 M52 101 v5 M55 101 l1.5 5 M65 101 l-1.5 5 M68 101 v5 M71 101 l1.5 5"/>',
      '  <g class="tilt">',
      '    <path class="k-bronze" d="M37 28 L40 47 L53 37 Z"/>',
      '    <path class="k-bronze" d="M83 28 L80 47 L67 37 Z"/>',
      '    <circle class="k-bronze" cx="60" cy="50" r="24"/>',
      '    <path class="k-tan flat" d="M60 44 C54 34 36 36 37 51 C38 63 54 64 60 56 C66 64 82 63 83 51 C84 36 66 34 60 44 Z"/>',
      '    <g class="blink"><circle class="k-eye" cx="49" cy="50" r="8.5"/><circle class="k-pupil" cx="49.5" cy="50.5" r="4.6"/><circle class="k-shine" cx="51.2" cy="48.6" r="1.6"/></g>',
      '    <g class="blink"><circle class="k-eye" cx="71" cy="50" r="8.5"/><circle class="k-pupil" cx="70.5" cy="50.5" r="4.6"/><circle class="k-shine" cx="72.2" cy="48.6" r="1.6"/></g>',
      '    <path class="k-mahogany" d="M60 55 L55.5 61 Q60 66 64.5 61 Z"/>',
      '  </g>',
      '</g>',
    ].join(''),
  };
  var names = Object.keys(animals);
  var slots = document.querySelectorAll('[data-critter]');
  for (var i = 0; i < slots.length; i++) {
    var name = slots[i].getAttribute('data-critter');
    if (!animals[name]) name = names[Math.floor(Math.random() * names.length)];
    slots[i].innerHTML = '<svg class="critter ' + name + '" viewBox="0 0 120 120" aria-hidden="true">' + animals[name] + '</svg>';
  }
})();
