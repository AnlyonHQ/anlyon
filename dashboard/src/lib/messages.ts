export function isEventDeliveryMessage(message: {
	eventId?: string | null;
}): boolean {
	return message.eventId != null && message.eventId !== "";
}
