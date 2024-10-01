function pad(val: any) {
  return (val + '').padStart(2, '0');
}

const VERSION_SEPARATOR = '';

export function generateVersion(date?: Date) {
  const generateTime = date ?? new Date();

  const dateVersionMinor = `${generateTime.getFullYear()}${VERSION_SEPARATOR}${pad(generateTime.getMonth() + 1)}${pad(generateTime.getDate())}`;
  const dateVersionPatch = `${generateTime.getHours()}${pad(generateTime.getMinutes())}${pad(generateTime.getSeconds())}`;
  const version = `0.${dateVersionMinor}.${dateVersionPatch}`;

  return version;
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
