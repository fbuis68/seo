import type { Booking, Room } from "@prisma/client";

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Shape returned to the client — mirrors normaliseBooking() in the original
 * check-in prototype so the front-end JS keeps the exact same field names. */
export function normaliseBooking(b: Booking) {
  const nights = Math.round((b.endDate.getTime() - b.startDate.getTime()) / 86400000);
  return {
    id: b.id,
    code: b.code,
    personEmail: b.personEmail,
    personFirstname: b.personFirstname,
    personLastname: b.personLastname,
    personPhone: b.personPhone || "",
    startDate: iso(b.startDate),
    endDate: iso(b.endDate),
    nights,
    facilityCode: b.facilityCode || "",
    facilityName: b.facilityName || b.facilityCode || "",
    status: b.status,
    bookingType: b.bookingType || "",
    otaId: b.otaId || "",
    checkinDone: b.checkinDone,
    selectedRoomCode: b.selectedRoomCode || null,
    importedFrom: b.importedFrom || "",
    nfcCount: b.nfcCount,
    nfcEncodedAt: b.nfcEncodedAt ? iso(b.nfcEncodedAt) : null,
    createdAt: iso(b.createdAt),
    updatedAt: iso(b.updatedAt),
  };
}

export function normaliseRoom(r: Room) {
  return {
    code: r.code,
    name: r.name,
    floor: r.floor,
    surface: r.surface,
    category: r.category,
    type: r.type || "",
    capacity: r.capacity,
    rate: r.rate,
    description: r.description || "",
    pmr: r.pmr,
    nosmoking: r.nosmoking,
    connected: r.connected,
    tags: (r.tags as string[]) || [],
    photos: (r.photos as string[]) || [],
    available: r.available,
    x: r.x,
    y: r.y,
  };
}
