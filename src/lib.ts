function pad(val: any) {
  return (val + '').padStart(2, '0');
}

export function generateVersion(date?: Date) {
  const generateTime = date ?? new Date();
  const version = `${generateTime.getFullYear()}-${pad(generateTime.getMonth() + 1)}${pad(generateTime.getDate())}-${pad(generateTime.getHours())}${pad(generateTime.getMinutes())}${pad(generateTime.getSeconds())}`;
  return version;
}
