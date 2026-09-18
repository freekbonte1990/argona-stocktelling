import { useEffect, useState } from "react";
import { countingRepository } from "../../application/container";
import { BigButton } from "../components/BigButton";
import { useOffice } from "../hooks/useLiveData";

interface SettingsPageProps {
  officeId: string;
}

export function SettingsPage({ officeId }: SettingsPageProps) {
  const office = useOffice(officeId);
  const [names, setNames] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (office) setNames(office.locations.map((l) => l.name));
  }, [office]);

  if (!office) {
    return <p className="screen-subtitle">Bezig met laden...</p>;
  }

  async function handleSave() {
    if (!office) return;
    const updatedOffice = {
      ...office,
      locations: office.locations.map((location, index) => ({
        ...location,
        name: names[index]?.trim() || `Locatie ${location.number}`,
      })),
    };
    await countingRepository.saveOffice(updatedOffice);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="stack">
      <h1 className="screen-title">Instellingen</h1>
      <div className="card stack stack--tight">
        <div>
          <strong>Kantoor:</strong> {office.name}
        </div>
        <div>
          <strong>Basisdatum:</strong> {office.baseDate ?? "—"}
        </div>
      </div>
      <div className="card stack">
        <h2 style={{ margin: 0 }}>Locatienamen</h2>
        {office.locations.map((location, index) => (
          <label key={location.id} className="stack stack--tight">
            <span>Locatie {location.number}</span>
            <input
              className="search-input"
              value={names[index] ?? ""}
              onChange={(e) =>
                setNames((prev) => prev.map((n, i) => (i === index ? e.target.value : n)))
              }
            />
          </label>
        ))}
        <BigButton variant="secondary" onClick={handleSave}>
          {saved ? "Opgeslagen ✓" : "Namen opslaan"}
        </BigButton>
      </div>
    </div>
  );
}
