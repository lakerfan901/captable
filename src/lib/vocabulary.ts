export type Vocabulary = {
  holder: string;
  holders: string;
  unit: string;
  units: string;
  unitClass: string;
  unitClasses: string;
  schedule: string;
};

export function getVocabulary(entityType: "CORPORATION" | "LLC"): Vocabulary {
  if (entityType === "LLC") {
    return {
      holder: "Member",
      holders: "Members",
      unit: "Unit",
      units: "Units",
      unitClass: "Unit class",
      unitClasses: "Unit classes",
      schedule: "Member schedule",
    };
  }
  return {
    holder: "Stakeholder",
    holders: "Stakeholders",
    unit: "Share",
    units: "Shares",
    unitClass: "Share class",
    unitClasses: "Share classes",
    schedule: "Cap table",
  };
}
