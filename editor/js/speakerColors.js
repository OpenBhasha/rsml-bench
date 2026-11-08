// Stable by speaker ID: deleting or adding speakers never recolors the others.
export function speakerColor(id, alpha = 1) {
  if (id === 1) return `rgba(91, 60, 196, ${alpha})`;
  if (!Number.isSafeInteger(id) || id < 1) return `hsla(220, 8%, 55%, ${alpha})`;
  const hue = ((id - 1) * 137.508 + 260) % 360;
  return `hsla(${hue.toFixed(3)}, 62%, 44%, ${alpha})`;
}

export function applySpeakerColor(element, id) {
  const custom = Number.isSafeInteger(id) && id > 1;
  element.classList.toggle('has-speaker-color', custom);
  if (!custom) {
    element.style.removeProperty('--speaker-color');
    element.style.removeProperty('--speaker-soft');
    return;
  }
  element.style.setProperty('--speaker-color', speakerColor(id));
  element.style.setProperty('--speaker-soft', speakerColor(id, 0.1));
}
