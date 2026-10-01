"""Схема входящих событий (валидация на входе)."""
from typing import Literal, Optional

from pydantic import BaseModel, Field

EventType = Literal["clock", "position", "at_signal", "delay", "track_closed", "track_opened",
                    "switch_failure", "switch_repaired", "wagon_defect", "resource"]


class Event(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    ts: float = Field(gt=0, description="Время события, сим-секунды UNIX")
    type: EventType
    train: Optional[str] = None
    km: Optional[float] = Field(default=None, ge=0, le=500)
    speed: Optional[float] = Field(default=None, ge=0, le=200)
    minutes: Optional[float] = Field(default=None, ge=-60, le=600)
    track: Optional[int] = Field(default=None, ge=1, le=50)
    switch: Optional[str] = None
    resource: Optional[Literal["inspectors", "locos", "crews"]] = None
    delta: Optional[int] = Field(default=None, ge=-20, le=20)
    reason: Optional[str] = Field(default=None, max_length=200)
    speed_factor: Optional[float] = None
    sent_wall_ms: Optional[float] = None


class IncidentRequest(BaseModel):
    type: Literal["delay", "track_closed", "track_opened", "switch_failure", "switch_repaired",
                  "wagon_defect", "resource"]
    train: Optional[str] = None
    minutes: Optional[float] = 30
    track: Optional[int] = None
    switch: Optional[str] = None
    resource: Optional[Literal["inspectors", "locos", "crews"]] = None
    delta: Optional[int] = None
